#!/usr/bin/env python3
"""anygo-worker: backend for luci-app-anygo.

Runs on the router and serves its HTTP API over a Unix socket.
Uses pymobiledevice3 to:

  * discover paired iPhones advertising `_remotepairing._tcp` over Wi-Fi
  * establish the RemotePairing tunnel (QUIC or TLS-PSK/TCP)
  * open RSD + DVT + LocationSimulation
  * set/clear coordinates, replay routes, keep sessions alive

The LuCI frontend talks to this worker through rpcd/ubus; the worker itself
only binds 127.0.0.1 and never exposes a LAN port.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import io
import json
import logging
import math
import os
import plistlib
import re
import signal
import socket
import time
import uuid
import zipfile
from collections import deque
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

DATA = Path(os.environ.get("ANYGO_DATA", "/opt/anygo/data"))
os.environ.setdefault("HOME", str(DATA))  # pymobiledevice3 stores pair records in ~/.pymobiledevice3
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "meta").mkdir(parents=True, exist_ok=True)

from fastapi import FastAPI, HTTPException  # noqa: E402
from packaging.version import Version  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from pymobiledevice3.bonjour import iter_browse_remotepairing  # noqa: E402
from pymobiledevice3.exceptions import MuxException, RemotePairingCompletedError  # noqa: E402
from pymobiledevice3.lockdown import create_using_usbmux  # noqa: E402
from pymobiledevice3.pair_records import get_home_folder  # noqa: E402
from pymobiledevice3.remote.common import TunnelProtocol  # noqa: E402
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService  # noqa: E402
from pymobiledevice3.remote.siphash import validate_auth_tag  # noqa: E402
from pymobiledevice3.remote.tunnel_service import (  # noqa: E402
    CoreDeviceTunnelProxy,
    RemotePairingLockdownService,
    get_remote_pairing_tunnel_services,
    start_tunnel_over_remotepairing,
)
import pymobiledevice3.remote.tunnel_service as tunnel_service  # noqa: E402
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider  # noqa: E402
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation  # noqa: E402
from pymobiledevice3.usbmux import list_devices  # noqa: E402

VERSION = "0.1.0"
LOCATION_REFRESH_INTERVAL = 2.0
LOCATION_WRITE_TIMEOUT = 6.0
UDID_RE = re.compile(r"^[0-9A-Fa-f][0-9A-Fa-f-]{5,63}$")

logger = logging.getLogger("anygo")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logger.addHandler(handler)

LOG_RING: deque[dict[str, Any]] = deque(maxlen=800)
TUN_LOCK = asyncio.Lock()


def log(level: str, msg: str, udid: Optional[str] = None) -> None:
    getattr(logger, level.lower(), logger.info)(f"[{udid or '-'}] {msg}")
    LOG_RING.append({"ts": time.time(), "level": level.upper(), "udid": udid or "", "msg": msg})


# --------------------------------------------------------------------------- models


@dataclass
class Device:
    udid: str
    name: str = "iPhone"
    model: str = ""
    ios: str = ""
    ip: Optional[str] = None
    port: Optional[int] = None
    last_seen: float = 0.0
    state: str = "offline"  # offline|online|connecting|ready|simulating|error
    error: Optional[str] = None
    error_code: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    session: Optional["Session"] = None
    slot: int = 0
    usb_attached: bool = False
    transport: Optional[str] = None
    location_sent_at: Optional[float] = None

    def is_online(self) -> bool:
        return self.usb_attached or (time.time() - self.last_seen) < 15

    def json(self) -> dict[str, Any]:
        return {
            "udid": self.udid,
            "name": self.name,
            "model": self.model,
            "ios": self.ios,
            "ip": self.ip,
            "state": self.state,
            "error": self.error,
            "error_code": self.error_code,
            "lat": self.lat,
            "lon": self.lon,
            "online": self.is_online(),
            "usb_attached": self.usb_attached,
            "transport": self.transport,
            "location_sent_at": self.location_sent_at,
        }


@dataclass
class Route:
    id: str
    udids: list[str]
    points: list[list[float]]
    speed: float
    loop: bool
    state: str = "running"  # running|paused|stopped
    progress: float = 0.0
    task: Optional[asyncio.Task] = None

    def json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "udids": self.udids,
            "state": self.state,
            "progress": round(self.progress, 4),
            "speed": self.speed,
            "loop": self.loop,
            "points": len(self.points),
        }


class SessionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class PairImportReq(BaseModel):
    name: Optional[str] = None
    data: str = Field(..., description="base64 of a .pair zip")


class UdidReq(BaseModel):
    udid: str


class LocationReq(BaseModel):
    udids: list[str]
    lat: float
    lon: float


class ClearReq(BaseModel):
    udids: list[str]


class RouteReq(BaseModel):
    udids: list[str]
    points: list[list[float]]
    speed: float = 1.4
    loop: bool = False


class RouteControlReq(BaseModel):
    id: str
    action: str  # pause|resume|stop


class ConfigReq(BaseModel):
    amap_key: Optional[str] = None
    default_speed: Optional[float] = None
    max_devices: Optional[int] = None
    restore_on_stop: Optional[bool] = None


# --------------------------------------------------------------------------- state

DEVICES: dict[str, Device] = {}
ROUTES: dict[str, Route] = {}
CONFIG: dict[str, Any] = {
    "amap_key": os.environ.get("AMAP_JS_KEY", ""),
    "default_speed": 1.4,
    "max_devices": 4,
    "restore_on_stop": True,
}


def config_path() -> Path:
    return DATA / "config.json"


def load_config() -> None:
    try:
        CONFIG.update(json.loads(config_path().read_text("utf-8")))
    except (OSError, ValueError):
        pass


def save_config() -> None:
    config_path().write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2), "utf-8")


def record_dir() -> Path:
    return get_home_folder()


def meta_path(udid: str) -> Path:
    return DATA / "meta" / f"{udid}.json"


def _next_slot() -> int:
    used = {d.slot for d in DEVICES.values()}
    slot = 0
    while slot in used:
        slot += 1
    return slot


def load_devices() -> None:
    """Load Wi-Fi records and devices explicitly enrolled over USB."""
    candidates = {p.stem.removeprefix("remote_") for p in record_dir().glob("remote_*.plist")}
    candidates.update(p.stem for p in (DATA / "meta").glob("*.json"))
    known: set[str] = set()
    for udid in sorted(candidates):
        if not UDID_RE.match(udid):
            continue
        meta: dict[str, Any] = {}
        try:
            meta = json.loads(meta_path(udid).read_text("utf-8"))
        except (OSError, ValueError):
            pass
        if not meta.get("usbPaired") and not (record_dir() / f"remote_{udid}.plist").is_file():
            continue
        known.add(udid)
        if udid in DEVICES:
            continue
        DEVICES[udid] = Device(
            udid=udid,
            name=meta.get("name") or "iPhone",
            model=meta.get("productType") or "",
            ios=meta.get("ios") or "",
            slot=_next_slot(),
        )
    for udid in list(DEVICES):
        if udid not in known:
            dev = DEVICES.pop(udid)
            if dev.session:
                dev.session.stop()


# --------------------------------------------------------------------------- session


def classify_error(exc: Exception) -> SessionError:
    """Map pymobiledevice3 exceptions to user-facing codes."""
    if isinstance(exc, SessionError):
        return exc
    text = repr(exc)
    low = text.lower()
    if "invalidservice" in low or "developer mode" in low or "entitlement" in low:
        return SessionError("E_DEV_MODE", "请在 iPhone「设置 → 隐私与安全性 → 开发者模式」开启并重启")
    if "unlock" in low or "locked" in low or "passcode" in low:
        return SessionError("E_LOCKED", "请解锁 iPhone 后重试")
    if "pair" in low and ("verify" in low or "record" in low or "auth" in low):
        return SessionError("E_PAIR", "配对记录无效或已失效，请重新配对")
    if "timeout" in low or "timed out" in low:
        return SessionError("E_TIMEOUT", "连接超时，请检查 iPhone 与路由器是否同一网段")
    return SessionError("E_TUNNEL", f"连接失败: {text}")


def usb_serial(udid: str) -> str:
    return udid.replace("-", "").upper()


async def attached_usb_serials() -> dict[str, str]:
    try:
        devices = await asyncio.wait_for(list_devices(), timeout=1.5)
    except (OSError, MuxException, TimeoutError):
        return {}
    return {usb_serial(device.serial): device.serial for device in devices if device.is_usb}


class Session:
    def __init__(self, device: Device) -> None:
        self.device = device
        self.queue: asyncio.Queue[tuple] = asyncio.Queue()
        self.ready = asyncio.Event()
        self._stop = False
        self._task: Optional[asyncio.Task] = None
        self._last_error: Optional[SessionError] = None
        self._loc: Optional[LocationSimulation] = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop = False
            self._task = asyncio.create_task(self._run(), name=f"anygo-{self.device.udid}")

    def stop(self) -> None:
        """Ask the session to clear the location and close the tunnel gracefully."""
        self._stop = True
        self._forget_location()
        if self._task is None or self._task.done():
            return
        with suppress(Exception):
            self.queue.put_nowait(("stop", None, None, None))
        try:
            loop = asyncio.get_running_loop()
            loop.call_later(6.0, self._hard_cancel)
        except RuntimeError:
            self._hard_cancel()

    def _hard_cancel(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()

    async def wait_ready(self, timeout: float = 20.0) -> None:
        try:
            await asyncio.wait_for(self.ready.wait(), timeout)
        except asyncio.TimeoutError:
            err = self._last_error
            raise SessionError(err.code if err else "E_TIMEOUT", str(err) if err else "连接超时")

    async def set_location(self, lat: float, lon: float, timeout: float = 10.0) -> None:
        await self.wait_ready()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self.queue.put(("set", lat, lon, fut))
        try:
            await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise SessionError("E_TIMEOUT", "设置坐标超时")

    async def clear(self, timeout: float = 10.0) -> None:
        # Stop renewing immediately, including while waiting for a reconnect.
        self._forget_location()
        await self.wait_ready()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self.queue.put(("clear", None, None, fut))
        try:
            await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise SessionError("E_TIMEOUT", "清除坐标超时")

    def _forget_location(self) -> None:
        self.device.lat = None
        self.device.lon = None
        self.device.location_sent_at = None

    async def _publish_location(self, loc: LocationSimulation, lat: float, lon: float) -> None:
        await asyncio.wait_for(loc.set(lat, lon), timeout=LOCATION_WRITE_TIMEOUT)
        if not self._stop:
            self.device.location_sent_at = time.time()

    def _protocols(self) -> list[TunnelProtocol]:
        order = [TunnelProtocol.QUIC, TunnelProtocol.TCP]
        ver = self.device.ios
        try:
            major, minor = (int(x) for x in ver.split(".")[:2])
            if (major, minor) >= (18, 2):
                order = [TunnelProtocol.TCP, TunnelProtocol.QUIC]
        except (ValueError, AttributeError):
            pass
        return order

    async def _open_tunnel(self) -> tuple[Any, Any]:
        """Return (cm, TunnelResult); caller must close cm."""
        services = await get_remote_pairing_tunnel_services(bonjour_timeout=4.0, udid=self.device.udid)
        if not services:
            raise SessionError("E_NO_MDNS", "未发现设备（检查同一网段、AP 隔离与开发者模式）")
        svc = services[0]
        last_exc: Optional[Exception] = None
        for proto in self._protocols():
            try:
                async with TUN_LOCK:
                    old = tunnel_service.DEFAULT_INTERFACE_NAME
                    # Linux TUN names are limited to 15 chars; "an<slot>-<uuid>" stays unique.
                    tunnel_service.DEFAULT_INTERFACE_NAME = f"an{self.device.slot}"
                    cm = start_tunnel_over_remotepairing(svc, protocol=proto)
                    try:
                        tun = await cm.__aenter__()
                    finally:
                        tunnel_service.DEFAULT_INTERFACE_NAME = old
                return cm, tun
            except SessionError:
                raise
            except Exception as exc:  # try the other transport
                last_exc = exc
                log("warning", f"tunnel {proto} failed: {exc!r}", self.device.udid)
                with suppress(Exception):
                    await svc.close()
                services = await get_remote_pairing_tunnel_services(
                    bonjour_timeout=4.0, udid=self.device.udid
                )
                if not services:
                    break
                svc = services[0]
        if last_exc is not None:
            raise classify_error(last_exc)
        raise SessionError("E_TUNNEL", "隧道建立失败")

    @asynccontextmanager
    async def _usb_tunnel(self, serial: str):
        async with AsyncExitStack() as stack:
            lockdown = await create_using_usbmux(
                serial=serial, connection_type="USB", autopair=False
            )
            await stack.enter_async_context(lockdown)
            if not lockdown.paired:
                raise SessionError("E_USB_PAIR", "请解锁 iPhone，并在设备配对中执行 USB 直连配对")
            if Version(lockdown.product_version) < Version("17.4"):
                raise SessionError("E_USB_VERSION", "USB 直连定位需要 iOS 17.4 或更新版本")
            proxy = await CoreDeviceTunnelProxy.create(lockdown)
            stack.push_async_callback(proxy.close)
            async with TUN_LOCK:
                tun = await stack.enter_async_context(proxy.start_tcp_tunnel())
            yield tun

    async def _enter_location(self, stack: AsyncExitStack, tun) -> LocationSimulation:
        rsd = await stack.enter_async_context(RemoteServiceDiscoveryService((tun.address, tun.port)))
        dvt = await stack.enter_async_context(DvtProvider(rsd))
        return await stack.enter_async_context(LocationSimulation(dvt))

    @asynccontextmanager
    async def _open_channel(self):
        usb_error = None
        async with AsyncExitStack() as stack:
            serial = (await attached_usb_serials()).get(usb_serial(self.device.udid))
            self.device.usb_attached = serial is not None
            if serial is not None:
                try:
                    async with asyncio.timeout(9):
                        tun = await stack.enter_async_context(self._usb_tunnel(serial))
                        loc = await self._enter_location(stack, tun)
                except Exception as exc:
                    usb_error = classify_error(exc)
                    log("warning", f"USB unavailable, trying Wi-Fi: {exc!r}", self.device.udid)
                    with suppress(Exception):
                        await stack.aclose()
                else:
                    yield "usb", tun, loc
                    return
            try:
                cm, tun = await self._open_tunnel()
            except SessionError as exc:
                if usb_error and exc.code == "E_NO_MDNS":
                    raise usb_error from exc
                raise
            stack.push_async_exit(cm)
            loc = await self._enter_location(stack, tun)
            yield "wifi", tun, loc

    async def _run_usb_commands(self, tun, loc: LocationSimulation) -> None:
        commands = asyncio.create_task(self._command_loop(loc))
        closed = asyncio.create_task(tun.client.wait_closed())
        try:
            done, _ = await asyncio.wait((commands, closed), return_when=asyncio.FIRST_COMPLETED)
            if commands in done:
                await commands
            else:
                await closed
                raise SessionError("E_USB_LOST", "USB 已断开，正在尝试重新连接")
        finally:
            for task in (commands, closed):
                task.cancel()
            await asyncio.gather(commands, closed, return_exceptions=True)

    async def _run(self) -> None:
        attempt = 0
        backoff = 1.0
        while not self._stop:
            try:
                self.device.state = "connecting"
                self.device.error = None
                self.device.error_code = None
                async with self._open_channel() as (transport, tun, loc):
                    try:
                        if self._stop:
                            break
                        self._loc = loc
                        self.device.transport = transport
                        lat, lon = self.device.lat, self.device.lon
                        if lat is not None and lon is not None:
                            await self._publish_location(loc, lat, lon)
                        self.device.state = "simulating" if self.device.lat is not None else "ready"
                        self._last_error = None
                        self.ready.set()
                        attempt = 0
                        backoff = 1.0
                        log("info", f"DVT location channel ready via {transport}", self.device.udid)
                        if transport == "usb":
                            await self._run_usb_commands(tun, loc)
                        else:
                            await self._command_loop(loc)
                    finally:
                        self.ready.clear()
                        if self._stop:
                            with suppress(Exception):
                                await asyncio.wait_for(loc.clear(), timeout=3)
            except asyncio.CancelledError:
                break
            except SessionError as exc:
                self._last_error = exc
                self.device.state = "error"
                self.device.error = str(exc)
                self.device.error_code = exc.code
                log("error", str(exc), self.device.udid)
                if exc.code in ("E_NO_MDNS", "E_PAIR"):
                    backoff = 5.0
            except Exception as exc:
                err = classify_error(exc)
                self._last_error = err
                self.device.state = "error"
                self.device.error = str(err)
                self.device.error_code = err.code
                log("error", f"session failed: {exc!r}", self.device.udid)
            finally:
                self.ready.clear()
                self._loc = None
                self.device.transport = None
            if self._stop:
                break
            attempt += 1
            await asyncio.sleep(min(30.0, backoff * (2 ** min(attempt, 4))))
        if self.device.state != "error":
            self.device.state = "online" if self.device.is_online() else "offline"

    async def _command_loop(self, loc: LocationSimulation) -> None:
        while not self._stop:
            try:
                if self.device.lat is not None and self.device.lon is not None:
                    cmd = await asyncio.wait_for(self.queue.get(), timeout=LOCATION_REFRESH_INTERVAL)
                else:
                    cmd = await self.queue.get()
            except asyncio.TimeoutError:
                lat, lon = self.device.lat, self.device.lon
                if not self._stop and lat is not None and lon is not None:
                    await self._publish_location(loc, lat, lon)
                continue

            kind, lat, lon, fut = cmd
            if self._stop or kind == "stop":
                return
            if fut.done():
                continue
            try:
                if kind == "set":
                    await self._publish_location(loc, lat, lon)
                    if not self._stop:
                        self.device.lat = lat
                        self.device.lon = lon
                        self.device.state = "simulating"
                elif kind == "clear":
                    self._forget_location()
                    await asyncio.wait_for(loc.clear(), timeout=LOCATION_WRITE_TIMEOUT)
                    self.device.state = "ready"
                if not fut.done():
                    fut.set_result(True)
            except Exception as exc:
                if not fut.done():
                    fut.set_exception(classify_error(exc))
                raise


# --------------------------------------------------------------------------- discovery


async def discovery_loop() -> None:
    while True:
        try:
            attached = await attached_usb_serials()
            for dev in DEVICES.values():
                was_attached = dev.usb_attached
                dev.usb_attached = usb_serial(dev.udid) in attached
                if dev.usb_attached and not was_attached and dev.state in ("offline", "error"):
                    dev.state = "online"
                    dev.error = None
                    dev.error_code = None
            records: dict[str, dict] = {}
            for plist in record_dir().glob("remote_*.plist"):
                udid = plist.name[len("remote_") : -len(".plist")]
                try:
                    records[udid] = plistlib.loads(plist.read_bytes())
                except (OSError, plistlib.InvalidFileException):
                    continue
            seen: dict[str, tuple[str, int]] = {}
            if records:
                async for inst in iter_browse_remotepairing(timeout=3.5):
                    ident = inst.properties.get("identifier")
                    tag = inst.properties.get("authTag")
                    if not ident or not tag:
                        continue
                    for udid, rec in records.items():
                        irk = rec.get("peer_alt_irk")
                        if isinstance(irk, bytes) and len(irk) == 16 and validate_auth_tag(irk, ident, tag):
                            ip = next(
                                (a.full_ip for a in inst.addresses if ":" not in a.ip), None
                            ) or (inst.addresses[0].full_ip if inst.addresses else None)
                            if ip:
                                seen[udid] = (ip, inst.port)
                            break
            now = time.time()
            for udid, (ip, port) in seen.items():
                dev = DEVICES.get(udid)
                if dev is None:
                    continue
                dev.ip, dev.port, dev.last_seen = ip, port, now
                if dev.state in ("offline", "error"):
                    dev.state = "online"
                    dev.error = None
                    dev.error_code = None
            for dev in DEVICES.values():
                if not dev.is_online() and dev.state == "online":
                    dev.state = "offline"
        except asyncio.CancelledError:
            return
        except Exception as exc:
            log("warning", f"discovery: {exc!r}")
        await asyncio.sleep(2.0)


# --------------------------------------------------------------------------- helpers


def ensure_session(udid: str) -> Session:
    dev = DEVICES.get(udid)
    if dev is None:
        raise HTTPException(404, f"未配对设备 {udid}")
    if dev.session is None:
        dev.session = Session(dev)
    dev.session.start()
    return dev.session


async def set_one(udid: str, lat: float, lon: float) -> None:
    sess = ensure_session(udid)
    await sess.set_location(lat, lon)


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def cumulative(points: list[list[float]]) -> list[float]:
    out = [0.0]
    for i in range(1, len(points)):
        out.append(out[-1] + haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]))
    return out


def point_at(points: list[list[float]], cum: list[float], dist: float) -> tuple[float, float]:
    if dist <= 0:
        return points[0][0], points[0][1]
    if dist >= cum[-1]:
        return points[-1][0], points[-1][1]
    lo, hi = 0, len(cum) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cum[mid] <= dist:
            lo = mid
        else:
            hi = mid
    seg = cum[lo + 1] - cum[lo]
    t = 0.0 if seg <= 0 else (dist - cum[lo]) / seg
    lat = points[lo][0] + (points[lo + 1][0] - points[lo][0]) * t
    lon = points[lo][1] + (points[lo + 1][1] - points[lo][1]) * t
    return lat, lon


async def run_route(route: Route) -> None:
    cum = cumulative(route.points)
    total = cum[-1]
    dist = 0.0
    if total <= 0:
        route.state = "stopped"
        return
    next_tick = time.monotonic()
    while route.state != "stopped":
        if route.state == "paused":
            await asyncio.sleep(0.2)
            next_tick = time.monotonic()
            continue
        lat, lon = point_at(route.points, cum, dist)
        for udid in list(route.udids):
            try:
                await set_one(udid, lat, lon)
            except Exception as exc:
                log("warning", f"route set {udid}: {exc!r}", udid)
        route.progress = dist / total
        if dist >= total:
            if route.loop:
                dist = 0.0
            else:
                route.state = "stopped"
                break
        next_tick += 1.0
        delay = next_tick - time.monotonic()
        if delay < -2.0:  # falling behind (slow device): resync instead of bursting
            next_tick = time.monotonic()
            delay = 0.0
        await asyncio.sleep(max(0.0, delay))
        dist += route.speed


# --------------------------------------------------------------------------- app


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_config()
    load_devices()
    task = asyncio.create_task(discovery_loop())
    log("info", f"anygo-worker {VERSION} started; data={DATA}")
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        for dev in DEVICES.values():
            if dev.session:
                dev.session.stop()
        for route in ROUTES.values():
            if route.task:
                route.task.cancel()


app = FastAPI(title="anygo-worker", lifespan=lifespan)


@app.get("/api/status")
async def status() -> dict[str, Any]:
    return {
        "version": VERSION,
        "now": time.time(),
        "config": CONFIG,
        "devices": [d.json() for d in DEVICES.values()],
        "routes": [r.json() for r in ROUTES.values()],
    }


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return CONFIG


@app.post("/api/config")
async def set_config(req: ConfigReq) -> dict[str, Any]:
    for key, value in req.model_dump(exclude_none=True).items():
        CONFIG[key] = value
    save_config()
    return CONFIG


async def _pair_usb() -> dict[str, Any]:
    """Pair over a physical USB connection and optionally prepare Wi-Fi fallback."""
    usb_socket = Path(os.environ.get("USBMUXD_SOCKET_ADDRESS", "/var/run/usbmuxd"))
    if not usb_socket.is_socket():
        raise SessionError("E_USB", "usbmuxd 未运行：请检查路由器的 AnyGo USB 服务")
    try:
        devices = await asyncio.wait_for(list_devices(), timeout=1.5)
    except (OSError, MuxException, TimeoutError) as exc:
        raise SessionError("E_USB", "usbmuxd 无响应") from exc
    device = next((d for d in devices if d.is_usb), None)
    if device is None:
        raise SessionError("E_USB", "未发现 USB 设备：请插好 iPhone、解锁屏幕并点“信任此电脑”")
    udid = device.serial
    if not UDID_RE.fullmatch(udid):
        raise SessionError("E_USB", "无法读取有效的设备 UDID")
    log("info", "USB pairing started", udid)

    try:
        async with asyncio.timeout(30):
            lockdown = await create_using_usbmux(
                serial=udid, connection_type="USB", autopair=True, pair_timeout=25
            )
    except TimeoutError as exc:
        raise SessionError("E_USB", "配对超时：请在 iPhone 上点“信任”并输入锁屏密码") from exc

    async with lockdown:
        meta = {
            "udid": udid,
            "name": lockdown.all_values.get("DeviceName") or lockdown.display_name or "iPhone",
            "productType": lockdown.product_type or "",
            "ios": lockdown.product_version,
            "build": lockdown.product_build_version or "",
            "wifiMac": lockdown.wifi_mac_address or "",
            "usbPaired": True,
            "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        record = record_dir() / f"remote_{udid}.plist"
        if not record.exists():
            try:
                async with asyncio.timeout(6):
                    await lockdown.set_enable_wifi_connections(True)
                    service = await RemotePairingLockdownService.create(lockdown)
                    try:
                        with suppress(RemotePairingCompletedError):
                            await service.connect(autopair=True)
                    finally:
                        await service.close()
            except Exception as exc:
                log("info", f"USB paired; Wi-Fi pairing unavailable: {exc!r}", udid)

    meta_path(udid).write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    if udid in DEVICES and DEVICES[udid].session:
        DEVICES[udid].session.stop()
    DEVICES.pop(udid, None)
    load_devices()
    DEVICES[udid].usb_attached = True
    DEVICES[udid].state = "online"
    log("info", "USB pairing done", udid)
    return {"ok": True, "udid": udid, "meta": meta, "wifi_paired": record.is_file()}


@app.post("/api/pair/import")
async def pair_import(req: PairImportReq) -> dict[str, Any]:
    try:
        raw = base64.b64decode(req.data, validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "数据不是合法的 base64")
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(400, "文件过大")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "不是合法的 .pair（zip）文件")

    manifest: dict[str, Any] = {}
    plist_name: Optional[str] = None
    plist_bytes: Optional[bytes] = None
    for info in zf.infolist():
        name = info.filename
        if name == "manifest.json":
            with suppress(ValueError):
                manifest = json.loads(zf.read(info).decode("utf-8"))
        elif re.match(r"^remote_[0-9A-Fa-f-]+\.plist$", name):
            plist_name, plist_bytes = name, zf.read(info)
    if not plist_name or plist_bytes is None:
        raise HTTPException(400, "缺少 remote_<udid>.plist")
    udid = plist_name[len("remote_") : -len(".plist")]
    if not UDID_RE.match(udid):
        raise HTTPException(400, "UDID 不合法")
    try:
        record = plistlib.loads(plist_bytes)
    except Exception:
        raise HTTPException(400, "配对记录不是合法的 plist")
    if not isinstance(record.get("peer_alt_irk"), bytes) or len(record["peer_alt_irk"]) != 16:
        raise HTTPException(400, "配对记录缺少 peer_alt_irk，请在电脑上重新导出")

    record_dir().mkdir(parents=True, exist_ok=True)
    target = record_dir() / f"remote_{udid}.plist"
    target.write_bytes(plist_bytes)
    target.chmod(0o600)
    meta = {
        "udid": udid,
        "name": manifest.get("name") or req.name or "iPhone",
        "productType": manifest.get("productType") or "",
        "ios": manifest.get("ios") or "",
        "build": manifest.get("build") or "",
        "wifiMac": manifest.get("wifiMac") or "",
        "pairedAt": manifest.get("pairedAt") or "",
    }
    meta_path(udid).write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")

    if udid in DEVICES and DEVICES[udid].session:
        DEVICES[udid].session.stop()
    DEVICES.pop(udid, None)
    load_devices()
    log("info", f"pair imported: {udid}", udid)
    return {"ok": True, "udid": udid, "meta": meta}


@app.post("/api/pair/usb")
async def pair_usb() -> dict[str, Any]:
    try:
        return await _pair_usb()
    except SessionError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(500, f"USB 配对失败: {exc!r}")


@app.get("/api/pair/list")
async def pair_list() -> list[dict[str, Any]]:
    out = []
    for dev in DEVICES.values():
        out.append({"udid": dev.udid, "name": dev.name, "ios": dev.ios, "model": dev.model,
                    "online": dev.is_online()})
    return out


@app.delete("/api/pair/{udid}")
async def pair_delete(udid: str) -> dict[str, Any]:
    if not UDID_RE.match(udid):
        raise HTTPException(400, "UDID 不合法")
    dev = DEVICES.pop(udid, None)
    if dev and dev.session:
        dev.session.stop()
    for path in (record_dir() / f"remote_{udid}.plist", meta_path(udid)):
        with suppress(OSError):
            path.unlink()
    return {"ok": True}


@app.post("/api/connect")
async def connect(req: UdidReq) -> dict[str, Any]:
    try:
        sess = ensure_session(req.udid)
        await sess.wait_ready(25)
    except SessionError as exc:
        raise HTTPException(400, str(exc))
    return DEVICES[req.udid].json()


@app.post("/api/disconnect")
async def disconnect(req: UdidReq) -> dict[str, Any]:
    dev = DEVICES.get(req.udid)
    if dev and dev.session:
        session = dev.session
        session.stop()
        if session._task is not None:
            with suppress(asyncio.CancelledError):
                await session._task
        if dev.session is session:
            dev.session = None
    if dev:
        dev.state = "online" if dev.is_online() else "offline"
    return {"ok": True}


@app.post("/api/location")
async def location(req: LocationReq) -> dict[str, Any]:
    if not (-90 <= req.lat <= 90 and -180 <= req.lon <= 180):
        raise HTTPException(400, "坐标超出范围")
    results = {}
    for udid in req.udids[: int(CONFIG.get("max_devices", 4))]:
        try:
            await set_one(udid, req.lat, req.lon)
            results[udid] = {"ok": True}
        except Exception as exc:
            results[udid] = {"ok": False, "error": str(exc)}
    return {"results": results}


@app.post("/api/clear")
async def clear(req: ClearReq) -> dict[str, Any]:
    results = {}
    for udid in req.udids:
        dev = DEVICES.get(udid)
        try:
            if dev and dev.session:
                await dev.session.clear()
            results[udid] = {"ok": True}
        except Exception as exc:
            results[udid] = {"ok": False, "error": str(exc)}
    return {"results": results}


@app.post("/api/route_start")
async def route_start(req: RouteReq) -> dict[str, Any]:
    pts = [[float(p[0]), float(p[1])] for p in req.points if len(p) >= 2]
    if len(pts) < 2:
        raise HTTPException(400, "路线至少需要 2 个点")
    if req.speed <= 0 or req.speed > 100:
        raise HTTPException(400, "速度不合法")
    route = Route(uuid.uuid4().hex[:12], req.udids, pts, req.speed, req.loop)
    ROUTES[route.id] = route
    route.task = asyncio.create_task(run_route(route))
    return {"id": route.id}


@app.post("/api/route_control")
async def route_control(req: RouteControlReq) -> dict[str, Any]:
    route = ROUTES.get(req.id)
    if route is None:
        raise HTTPException(404, "路线不存在")
    if req.action == "pause":
        route.state = "paused"
    elif req.action == "resume":
        route.state = "running"
    elif req.action == "stop":
        route.state = "stopped"
        if route.task:
            route.task.cancel()
        ROUTES.pop(route.id, None)
    else:
        raise HTTPException(400, "未知操作")
    return {"ok": True, "state": route.state}


@app.get("/api/logs")
async def logs(lines: int = 100) -> dict[str, Any]:
    # rpcd only accepts JSON objects from plugins, so wrap the array.
    return {"lines": list(LOG_RING)[-max(1, min(lines, 800)) :]}


def serve() -> None:
    import uvicorn

    def exit_after_signal(_signum, _frame):
        # Uvicorn replays the signal after shutdown. Exit through the socket cleanup.
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, exit_after_signal)
    signal.signal(signal.SIGINT, exit_after_signal)
    socket_path = Path(os.environ.get("ANYGO_SOCKET", str(DATA / "worker.sock")))
    os.umask(0o077)
    with socket_path.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(f"AnyGo is already listening on {socket_path}") from None
        if socket_path.is_socket():
            socket_path.unlink()

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(socket_path))
            try:
                socket_path.chmod(0o600)
                listener.listen(128)
                server = uvicorn.Server(uvicorn.Config(app, log_level="info"))
                server.run(sockets=[listener])
                if not server.started:
                    raise SystemExit(1)
            finally:
                socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    serve()
