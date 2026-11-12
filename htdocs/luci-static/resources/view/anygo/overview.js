'use strict';
'require view';
'require rpc';
'require poll';
'require anygo.common as common';

var callStatus = rpc.declare({ object: 'anygo', method: 'status' });
var callConfigGet = rpc.declare({ object: 'anygo', method: 'config_get' });
var callPairImport = rpc.declare({ object: 'anygo', method: 'pair_import', params: [ 'name', 'data' ] });
var callPairUsb = rpc.declare({ object: 'anygo', method: 'pair_usb' });
var callPairDelete = rpc.declare({ object: 'anygo', method: 'pair_delete', params: [ 'udid' ] });
var callConnect = rpc.declare({ object: 'anygo', method: 'connect', params: [ 'udid' ] });
var callDisconnect = rpc.declare({ object: 'anygo', method: 'disconnect', params: [ 'udid' ] });
var callSetLocation = rpc.declare({ object: 'anygo', method: 'set_location', params: [ 'udids', 'lat', 'lon' ] });
var callClear = rpc.declare({ object: 'anygo', method: 'clear_location', params: [ 'udids' ] });
var callRouteStart = rpc.declare({ object: 'anygo', method: 'route_start', params: [ 'udids', 'points', 'speed', 'loop' ] });
var callRouteControl = rpc.declare({ object: 'anygo', method: 'route_control', params: [ 'id', 'action' ] });

var PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
var HANGZHOU = [ 30.2741, 120.1551 ];
var FAVORITES_KEY = 'luci.anygo.favorites';
var CLICK_TELEPORT_KEY = 'luci.anygo.click-teleport';
var MAP_THEME_KEY = 'luci.anygo.map-theme';
var MAP_THEMES = {
	day: { style: 'amap://styles/whitesmoke', route: '#007278', outline: '#f4fffc' },
	night: { style: 'amap://styles/dark', route: '#64e6dc', outline: '#182526' }
};

function readMapTheme() {
	try {
		var saved = window.localStorage.getItem(MAP_THEME_KEY);
		if (saved === 'day' || saved === 'night')
			return saved;
	}
	catch (e) {}
	return 'auto';
}

function readClickTeleport() {
	try {
		return window.localStorage.getItem(CLICK_TELEPORT_KEY) !== 'false';
	}
	catch (e) {
		return true;
	}
}

function validCoordinates(lat, lon) {
	return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function outOfChina(lat, lng) {
	return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271);
}

function transformLat(x, y) {
	var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
	ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
	ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
	ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
	return ret;
}

function transformLng(x, y) {
	var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
	ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
	ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
	ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
	return ret;
}

function wgs84ToGcj02(lat, lng) {
	if (outOfChina(lat, lng))
		return [ lat, lng ];
	var dLat = transformLat(lng - 105.0, lat - 35.0);
	var dLng = transformLng(lng - 105.0, lat - 35.0);
	var radLat = lat / 180.0 * PI;
	var magic = Math.sin(radLat);
	magic = 1 - EE * magic * magic;
	var sqrtMagic = Math.sqrt(magic);
	dLat = (dLat * 180.0) / ((AXIS * (1 - EE)) / (magic * sqrtMagic) * PI);
	dLng = (dLng * 180.0) / (AXIS / sqrtMagic * Math.cos(radLat) * PI);
	return [ lat + dLat, lng + dLng ];
}

function gcj02ToWgs84(lat, lng) {
	if (outOfChina(lat, lng))
		return [ lat, lng ];
	var g = wgs84ToGcj02(lat, lng);
	return [ lat * 2 - g[0], lng * 2 - g[1] ];
}

function badge(state) {
	var map = {
		ready: [ '已连接', 'ok' ],
		simulating: [ '模拟中', 'ok' ],
		connecting: [ '连接中', 'warn' ],
		online: [ '在线', 'info' ],
		offline: [ '离线', 'muted' ],
		error: [ '错误', 'bad' ]
	};
	var v = map[state] || [ state || '未知', 'muted' ];
	return E('span', { 'class': 'anygo-badge anygo-badge-' + v[1] }, v[0]);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		common.loadStyles();
	},

	render: function() {
		return common.guardWorker(L.bind(function() {
			return Promise.all([
				callStatus().catch(function() { return null; }),
				callConfigGet().catch(function() { return null; })
			]).then(L.bind(this.renderPage, this));
		}, this));
	},

	renderPage: function(data) {
		var status = data[0] || {};
		var config = data[1] && !data[1].error ? data[1] : status.config || {};
		this.state = {
			status: status,
			config: config,
			selected: new Set((status.devices || []).map(function(d) { return d.udid; })),
			panel: 'location',
			mapTheme: readMapTheme(),
			routeMode: false,
			routePoints: [],
			routePath: []
		};

		var button = L.bind(function(label, handler, attrs) {
			return common.button(label, L.bind(this[handler], this), attrs);
		}, this);
		var devicePanel = E('section', { class: 'anygo-panel anygo-device-panel', 'aria-labelledby': 'anygo-device-title' }, [
			E('div', { class: 'anygo-panel-head' }, [
				E('h3', { id: 'anygo-device-title' }, '设备'),
				E('span', { id: 'anygo-selection', class: 'anygo-muted' })
			]),
			E('div', { id: 'anygo-devices', class: 'anygo-devices' }),
			E('details', { class: 'anygo-pair' }, [
				E('summary', {}, '设备配对'),
				E('div', { class: 'anygo-panel-body' }, [
					E('input', { id: 'anygo-pair-file', type: 'file', accept: '.pair,.zip', 'aria-label': '配对文件' }),
					E('div', { class: 'anygo-control-grid' }, [
						button('上传并导入', 'handlePairUpload'),
						button('USB 直连配对', 'handlePairUsb')
					]),
					button('移除所选配对', 'handlePairDelete', {
						id: 'anygo-pair-remove', class: 'anygo-button anygo-button-danger', disabled: ''
					})
				])
			])
		]);
		var overview = E('div', { class: common.themeClass() + ' anygo-overview' }, [
			E('div', { class: 'anygo-heading' }, E('h2', {}, '模拟定位')),
			E('div', { class: 'anygo-workspace' }, [
				E('section', { class: 'anygo-map-panel', 'aria-label': '定位地图' }, [
					E('div', { id: 'anygo-map' }, E('div', { class: 'anygo-map-empty' }, '地图加载中…')),
					E('div', { id: 'anygo-map-mode', class: 'anygo-map-mode', hidden: '' }, '点击地图添加路线点'),
					E('select', {
						id: 'anygo-map-theme', class: 'anygo-map-theme', 'aria-label': '地图主题',
						hidden: '', change: L.bind(this.handleMapTheme, this)
					}, [
						[ 'auto', '跟随界面' ], [ 'day', '远山黛' ], [ 'night', '幻影黑' ]
					].map(function(choice) {
						return E('option', {
							value: choice[0], selected: this.state.mapTheme === choice[0] ? '' : null
						}, choice[1]);
					}, this))
				]),
				E('aside', { class: 'anygo-sidebar' }, [
					E('section', { class: 'anygo-panel', 'aria-label': '地图操作' }, [
						E('div', { class: 'anygo-segments', role: 'group', 'aria-label': '地图操作' }, [
							common.button('定位', L.bind(this.selectPanel, this, 'location'), {
								id: 'anygo-show-location', 'aria-controls': 'anygo-location-panel', 'aria-pressed': 'true'
							}),
							common.button('路线', L.bind(this.selectPanel, this, 'route'), {
								id: 'anygo-show-route', 'aria-controls': 'anygo-route-panel', 'aria-pressed': 'false'
							})
						]),
						E('div', { id: 'anygo-location-panel', class: 'anygo-panel-body' }, [
							E('div', { class: 'anygo-control-grid' }, [
								E('label', { class: 'anygo-field' }, [
									E('span', {}, '纬度'),
									E('input', { id: 'anygo-lat', type: 'text', inputmode: 'decimal', placeholder: HANGZHOU[0].toFixed(6) })
								]),
								E('label', { class: 'anygo-field' }, [
									E('span', {}, '经度'),
									E('input', { id: 'anygo-lon', type: 'text', inputmode: 'decimal', placeholder: HANGZHOU[1].toFixed(6) })
								])
							]),
							E('label', { class: 'anygo-switch' }, [
								E('span', {}, '点击地图即传送'),
								E('input', {
									id: 'anygo-click-teleport', type: 'checkbox', role: 'switch',
									checked: readClickTeleport() ? '' : null,
									change: function(ev) {
										try {
											window.localStorage.setItem(CLICK_TELEPORT_KEY, String(ev.target.checked));
										}
										catch (e) {}
									}
								}),
								E('span', { class: 'anygo-switch-track', 'aria-hidden': 'true' })
							]),
							E('div', { class: 'anygo-control-grid' }, [
								button('传送到此', 'handleTeleport', { class: 'anygo-button anygo-button-primary' }),
								button('恢复真实定位', 'handleClear')
							]),
							E('details', { class: 'anygo-favorites' }, [
								E('summary', {}, '收藏地点'),
								E('div', { id: 'anygo-favorite-list', class: 'anygo-favorite-list' }),
								E('form', { class: 'anygo-favorite-form', submit: L.bind(this.handleFavoriteSave, this) }, [
									E('label', { class: 'anygo-field' }, [
										E('span', {}, '当前坐标的名称'),
										E('input', { id: 'anygo-favorite-name', type: 'text', maxlength: '40', required: '' })
									]),
									E('button', { type: 'submit', class: 'anygo-button' }, '收藏坐标')
								])
							])
						]),
						E('div', { id: 'anygo-route-panel', class: 'anygo-panel-body', hidden: '' }, [
							E('div', { class: 'anygo-control-grid anygo-route-draw' }, [
								button('绘制路线', 'handleRouteMode', { id: 'anygo-route-mode', 'aria-pressed': 'false' }),
								E('span', { id: 'anygo-route-info', class: 'anygo-muted', role: 'status' })
							]),
							E('label', { class: 'anygo-file-action' }, [
								E('span', {}, '导入 GPX'),
								E('input', { id: 'anygo-gpx-file', type: 'file', accept: '.gpx', change: L.bind(this.handleGpxImport, this) })
							]),
							E('div', { class: 'anygo-control-grid anygo-route-options' }, [
								E('label', { class: 'anygo-field' }, [
									E('span', {}, '速度（m/s）'),
									E('input', { id: 'anygo-speed', type: 'number', min: '0', max: '100', step: 'any', value: config.default_speed || 1.4 })
								]),
								E('label', { class: 'anygo-switch' }, [
									E('span', {}, '循环播放'),
									E('input', { id: 'anygo-loop', type: 'checkbox', role: 'switch' }),
									E('span', { class: 'anygo-switch-track', 'aria-hidden': 'true' })
								])
							]),
							E('div', { class: 'anygo-control-grid anygo-route-actions' }, [
								button('开始路线', 'handleRouteStart', { id: 'anygo-route-start', class: 'anygo-button anygo-button-primary' }),
								button('暂停', 'handleRoutePause', { id: 'anygo-route-pause', hidden: '' }),
								button('继续', 'handleRouteResume', { id: 'anygo-route-resume', hidden: '' }),
								button('停止', 'handleRouteStop', { id: 'anygo-route-stop', hidden: '' })
							])
						])
					]),
					devicePanel
				])
			])
		]);

		overview.addEventListener('anygo-themechange', L.bind(this.syncMapTheme, this));
		window.setTimeout(L.bind(function() {
			this.renderDevices();
			this.renderFavorites();
			this.syncRouteInfo();
			this.initMap();
		}, this), 0);
		poll.add(L.bind(this.refresh, this), 3);

		return overview;
	},

	selectPanel: function(panel) {
		this.state.panel = panel;
		[ 'location', 'route' ].forEach(function(name) {
			document.getElementById('anygo-' + name + '-panel').hidden = name !== panel;
			document.getElementById('anygo-show-' + name).setAttribute('aria-pressed', String(name === panel));
		});
		this.syncRouteInfo();
	},

	refresh: function() {
		return callStatus().then(L.bind(function(status) {
			if (!status || status.error)
				return;
			this.state.status = status;
			this.renderDevices();
			this.syncMarker();
			this.syncRouteInfo();
		}, this)).catch(function() {});
	},

	renderDevices: function() {
		var list = document.getElementById('anygo-devices');
		if (!list)
			return;
		var devices = this.state.status.devices || [];
		var state = this.state;
		var fingerprint = JSON.stringify(devices, function(key, value) {
			return key === 'location_sent_at' ? undefined : value;
		});
		if (state.deviceFingerprint === fingerprint)
			return;
		state.deviceFingerprint = fingerprint;
		var focused = document.activeElement;
		var open = new Set(Array.from(list.querySelectorAll('details[open]'), function(node) {
			return node.parentElement.dataset.udid;
		}));
		var focusRow = focused && focused.closest('#anygo-devices [data-udid]');
		var focusId = focusRow && focusRow.dataset.udid;
		var focusAction = focusRow && focused.tagName;
		list.replaceChildren();
		if (!devices.length)
			list.appendChild(E('p', { class: 'anygo-empty' }, '暂无配对设备'));

		devices.forEach(L.bind(function(d) {
			var name = d.name || 'iPhone';
			var connected = d.state === 'ready' || d.state === 'simulating';
			var checkbox = E('input', { type: 'checkbox', 'aria-label': '选择 ' + name, change: L.bind(function(ev) {
				if (ev.target.checked)
					state.selected.add(d.udid);
				else
					state.selected.delete(d.udid);
				this.updateSelection();
			}, this) });
			checkbox.checked = state.selected.has(d.udid);
			var action = common.button(connected ? '断开' : '连接', L.bind(
				connected ? this.handleDisconnect : this.handleConnect, this, d.udid
			), { class: 'anygo-button anygo-button-small', 'aria-label': (connected ? '断开 ' : '连接 ') + name });
			action.disabled = d.state === 'connecting';
			var coords = d.lat != null && d.lon != null ? d.lat.toFixed(6) + ', ' + d.lon.toFixed(6) : null;
			var details = E('details', { class: 'anygo-device-details' }, [
				E('summary', {}, '设备详情'),
				E('div', {}, [ d.model, d.ip, coords, d.udid ].filter(Boolean).map(function(value) {
					return E('div', {}, value);
				}))
			]);
			details.open = open.has(d.udid);
			var row = E('article', { class: 'anygo-device', 'data-udid': d.udid }, [
				E('div', { class: 'anygo-device-main' }, [
					E('label', { class: 'anygo-device-select' }, checkbox),
					E('div', { class: 'anygo-device-title' }, [
						E('strong', {}, name),
						E('div', { class: 'anygo-device-meta' }, [
							badge(d.state),
							[
								d.transport === 'usb' ? 'USB' : d.transport === 'wifi' ? 'Wi-Fi' : d.usb_attached ? 'USB 已插入' : '',
								d.ios ? 'iOS ' + d.ios : ''
							].filter(Boolean).join(' · ')
						])
					]),
					action
				]),
				d.error ? E('p', { class: 'anygo-error' }, d.error) : '',
				details
			]);
			list.appendChild(row);
			if (d.udid === focusId) {
				var target = row.querySelector(focusAction.toLowerCase());
				if (target)
					target.focus({ preventScroll: true });
			}
		}, this));
		this.updateSelection();
	},

	updateSelection: function() {
		var count = this.selectedUuids().length;
		document.getElementById('anygo-selection').textContent = count ? '已选 ' + count + ' 台' : '';
		document.getElementById('anygo-pair-remove').disabled = count === 0;
	},

	resolveMapTheme: function(panel) {
		return this.state.mapTheme === 'auto'
			? (panel.closest('.anygo').classList.contains('anygo-dark') ? 'night' : 'day')
			: this.state.mapTheme;
	},

	handleMapTheme: function(ev) {
		var mode = ev.target.value;
		var state = this.state;
		if (!state.map || (mode !== 'auto' && mode !== 'day' && mode !== 'night'))
			return;
		state.mapTheme = mode;
		try {
			if (mode === 'auto')
				window.localStorage.removeItem(MAP_THEME_KEY);
			else
				window.localStorage.setItem(MAP_THEME_KEY, mode);
		}
		catch (e) {}
		this.syncMapTheme();
	},

	syncMapTheme: function() {
		var state = this.state;
		if (!state.map)
			return;
		var panel = document.getElementById('anygo-map').closest('.anygo-map-panel');
		var theme = this.resolveMapTheme(panel);
		if (panel.dataset.mapTheme === theme)
			return;
		panel.dataset.mapTheme = theme;
		state.map.setMapStyle(MAP_THEMES[theme].style);
		if (state.polyline)
			state.polyline.setOptions(this.routeStyle(theme));
	},

	routeStyle: function(theme) {
		var palette = MAP_THEMES[theme];
		return {
			strokeColor: palette.route, strokeWeight: 5, strokeOpacity: 1,
			isOutline: true, outlineColor: palette.outline, borderWeight: 2
		};
	},

	initMap: function() {
		var key = (this.state.config && this.state.config.amap_key) || '';
		var box = document.getElementById('anygo-map');
		if (!box)
			return;
		if (!key) {
			box.replaceChildren(E('div', { class: 'anygo-map-empty' }, [
				E('strong', {}, '地图尚未配置'),
				E('a', { href: L.url('admin/services/anygo/settings') }, '配置高德 JSAPI Key')
			]));
			return;
		}
		var self = this;
		function load(key) {
			if (window.AMap)
				return Promise.resolve(window.AMap);
			return new Promise(function(resolve, reject) {
				var s = document.createElement('script');
				s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key);
				s.async = true;
				s.onload = function() { resolve(window.AMap); };
				s.onerror = function() { reject(new Error('AMap 加载失败')); };
				document.head.appendChild(s);
			});
		}
		load(key).then(function(AMap) {
			if (!document.getElementById('anygo-map'))
				return;
			box.replaceChildren();
			var panel = box.closest('.anygo-map-panel');
			var theme = self.resolveMapTheme(panel);
			panel.dataset.mapTheme = theme;
			var center = wgs84ToGcj02(HANGZHOU[0], HANGZHOU[1]).reverse();
			var map = new AMap.Map('anygo-map', {
				zoom: 11, center: center, viewMode: '2D', mapStyle: MAP_THEMES[theme].style
			});
			var marker = new AMap.Marker({
				position: center, visible: false, anchor: 'center', clickable: false, bubble: true,
				content: E('span', { class: 'anygo-map-pin', 'aria-hidden': 'true' })
			});
			map.add(marker);
			self.state.map = map;
			self.state.marker = marker;
			self.state.polyline = null;
			document.getElementById('anygo-map-theme').hidden = false;

			map.on('click', function(ev) {
				self.state.favoritePreview = null;
				var lng = ev.lnglat.getLng(), lat = ev.lnglat.getLat();
				var wgs = gcj02ToWgs84(lat, lng);
				document.getElementById('anygo-lat').value = wgs[0].toFixed(6);
				document.getElementById('anygo-lon').value = wgs[1].toFixed(6);
				marker.setPosition([ lng, lat ]);
				marker.show();
				if (self.state.panel === 'route' && self.state.routeMode) {
					self.state.routePoints.push(wgs);
					self.state.routePath.push([ lng, lat ]);
					self.updatePolyline(false);
					self.syncRouteInfo();
				}
				else if (self.state.panel === 'location' && document.getElementById('anygo-click-teleport').checked) {
					self.teleport(wgs[0], wgs[1]);
				}
			});
			self.updatePolyline(true);
			if (self.state.favoritePreview)
				self.previewFavorite(self.state.favoritePreview);
			else
				self.syncMarker();
		}).catch(function(err) {
			var box2 = document.getElementById('anygo-map');
			if (box2)
				box2.replaceChildren(E('div', { class: 'anygo-map-empty' }, '高德地图加载失败：' + err.message));
		});
	},

	updatePolyline: function(fit) {
		var st = this.state;
		if (!st.map || st.routePath.length < 2)
			return;
		if (!st.polyline) {
			var panel = document.getElementById('anygo-map').closest('.anygo-map-panel');
			st.polyline = new window.AMap.Polyline(Object.assign({
				path: st.routePath.slice(), bubble: true, lineJoin: 'round', lineCap: 'round'
			}, this.routeStyle(panel.dataset.mapTheme)));
			st.map.add(st.polyline);
		}
		else {
			st.polyline.setPath(st.routePath);
		}
		if (fit)
			st.map.setFitView([ st.polyline ]);
	},

	syncMarker: function() {
		var st = this.state;
		if (!st.map || !st.marker || st.routeMode || st.favoritePreview)
			return;
		var devices = (st.status && st.status.devices) || [];
		var d = devices.find(function(x) { return st.selected.has(x.udid) && x.lat != null && x.lon != null; })
			|| devices.find(function(x) { return x.lat != null && x.lon != null; });
		if (!d)
			return;
		var g = wgs84ToGcj02(d.lat, d.lon);
		st.marker.setPosition([ g[1], g[0] ]);
		st.marker.show();
		var key = d.lat.toFixed(5) + ',' + d.lon.toFixed(5);
		if (st.lastCenterKey !== key) {
			st.lastCenterKey = key;
			st.map.setCenter([ g[1], g[0] ]);
		}
	},

	syncRouteInfo: function() {
		var el = document.getElementById('anygo-route-info');
		if (!el)
			return;
		var state = this.state;
		var count = state.routePoints.length;
		var route = (state.status.routes || []).find(function(r) {
			return r.id === state.routeId;
		});
		if (route && route.state === 'stopped') {
			state.routeState = route.progress >= 1 ? 'done' : 'stopped';
			state.routeId = null;
		}
		var active = state.routeState === 'running' || state.routeState === 'paused';
		var label = { running: '播放中', paused: '已暂停', done: '已完成', stopped: '已停止', error: '路线异常' };
		var text = active && route ? label[state.routeState] + ' · ' + Math.min(100, Math.round(route.progress * 100)) + '%' :
			[ label[state.routeState], count ? count + ' 个路线点' : '' ].filter(Boolean).join(' · ');
		if (el.textContent !== text)
			el.textContent = text;
		var draw = document.getElementById('anygo-route-mode');
		var drawLabel = state.routeMode ? '清除绘制' : '绘制路线';
		if (draw.textContent !== drawLabel)
			draw.textContent = drawLabel;
		draw.setAttribute('aria-pressed', String(state.routeMode));
		document.getElementById('anygo-map-mode').hidden = state.panel !== 'route' || !state.routeMode;
		document.getElementById('anygo-route-start').hidden = active;
		document.getElementById('anygo-route-start').disabled = state.routeBusy;
		document.getElementById('anygo-route-pause').hidden = state.routeState !== 'running';
		document.getElementById('anygo-route-resume').hidden = state.routeState !== 'paused';
		document.getElementById('anygo-route-stop').hidden = !active;
	},

	selectedUuids: function() {
		var state = this.state;
		return (state.status.devices || []).filter(function(d) {
			return state.selected.has(d.udid);
		}).map(function(d) { return d.udid; });
	},

	teleport: function(lat, lon) {
		var udids = this.selectedUuids();
		if (!udids.length) {
			common.notify('请先勾选至少一台设备', 'warning');
			return;
		}
		return callSetLocation(udids, lat, lon).then(L.bind(function(res) {
			this.state.favoritePreview = null;
			if (!res || !res.results)
				throw new Error(res && (res.detail || res.error) || '未收到设备回执');
			var devices = this.state.status.devices || [];
			var failed = udids.filter(function(udid) {
				return !res.results[udid] || res.results[udid].ok !== true;
			}).map(function(udid) {
				var device = devices.find(function(d) { return d.udid === udid; });
				var result = res.results[udid];
				return (device && device.name || udid) + '：' + (result && result.error || '未收到设备回执');
			});
			if (failed.length)
				common.notify((failed.length === udids.length ? '坐标下发失败：' : '部分设备下发失败：') + failed.join('；'), 'danger');
			else
				common.notify('坐标已下发 · ' + lat.toFixed(6) + ', ' + lon.toFixed(6), 'success');
			this.refresh();
		}, this)).catch(function(e) {
			common.notify('操作失败：' + e, 'danger');
		});
	},

	readCoordinates: function() {
		var latText = document.getElementById('anygo-lat').value.trim();
		var lonText = document.getElementById('anygo-lon').value.trim();
		var lat = Number(latText), lon = Number(lonText);
		return latText && lonText && validCoordinates(lat, lon) ? [ lat, lon ] : null;
	},

	handleTeleport: function() {
		var coordinates = this.readCoordinates();
		if (!coordinates)
			return common.notify('请输入合法坐标', 'warning');
		this.teleport(coordinates[0], coordinates[1]);
	},

	readFavorites: function() {
		try {
			var favorites = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || '[]');
			return Array.isArray(favorites) ? favorites.filter(function(place) {
				return place && typeof place.name === 'string' && validCoordinates(place.lat, place.lon);
			}) : [];
		}
		catch (e) {
			return [];
		}
	},

	writeFavorites: function(favorites) {
		try {
			window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
		}
		catch (e) {
			common.notify('当前浏览器无法保存收藏', 'danger');
			return false;
		}
		this.renderFavorites();
		return true;
	},

	renderFavorites: function() {
		var list = document.getElementById('anygo-favorite-list');
		var favorites = this.readFavorites();
		if (!favorites.length) {
			list.replaceChildren(E('p', { class: 'anygo-empty' }, '暂无收藏地点'));
			return;
		}
		list.replaceChildren.apply(list, favorites.map(L.bind(function(place) {
			return E('div', { class: 'anygo-favorite-row' }, [
				common.button(place.name, L.bind(this.previewFavorite, this, place), { class: 'anygo-button anygo-favorite-place' }),
				common.button('移除', L.bind(this.handleFavoriteRemove, this, place.name), { 'aria-label': '移除收藏 ' + place.name })
			]);
		}, this)));
	},

	handleFavoriteSave: function(ev) {
		ev.preventDefault();
		var input = document.getElementById('anygo-favorite-name');
		var name = input.value.trim();
		if (!name)
			return common.notify('请输入地点名称', 'warning');
		var coordinates = this.readCoordinates();
		if (!coordinates)
			return common.notify('请先在地图上选点，或填写有效坐标', 'warning');
		var favorites = this.readFavorites();
		if (favorites.some(function(place) { return place.name === name; }))
			return common.notify('该名称已用于其他收藏', 'warning');
		favorites.push({ name: name, lat: coordinates[0], lon: coordinates[1] });
		if (this.writeFavorites(favorites)) {
			input.value = '';
			common.notify('地点已收藏', 'success');
		}
	},

	handleFavoriteRemove: function(name) {
		var favorites = this.readFavorites().filter(function(place) { return place.name !== name; });
		if (this.writeFavorites(favorites))
			common.notify('已移除收藏', 'success');
	},

	previewFavorite: function(place) {
		document.getElementById('anygo-lat').value = place.lat.toFixed(6);
		document.getElementById('anygo-lon').value = place.lon.toFixed(6);
		var state = this.state;
		state.favoritePreview = place;
		if (!state.map)
			return;
		var point = wgs84ToGcj02(place.lat, place.lon).reverse();
		state.marker.setPosition(point);
		state.marker.show();
		state.map.setCenter(point);
	},

	handleClear: function() {
		var udids = this.selectedUuids();
		if (!udids.length)
			return common.notify('请先勾选设备', 'warning');
		callClear(udids).then(L.bind(function() {
			if (this.state.favoritePreview && this.state.marker)
				this.state.marker.hide();
			this.state.favoritePreview = null;
			common.notify('已恢复真实定位', 'success');
			this.refresh();
		}, this));
	},

	handleConnect: function(udid) {
		var close = common.notify('正在连接设备…', 'info');
		callConnect(udid).then(L.bind(function(res) {
			if (!res || !res.udid)
				throw new Error((res && (res.detail || res.error)) || '连接失败');
			common.notify(res.transport === 'usb' ? '已通过 USB 连接' :
				res.transport === 'wifi' ? '已通过 Wi-Fi 连接' : '已连接', 'success');
			this.refresh();
		}, this)).catch(function(e) {
			common.notify('连接失败：' + e, 'danger');
		}).finally(close);
	},

	handleDisconnect: function(udid) {
		callDisconnect(udid).then(L.bind(function() { this.refresh(); }, this));
	},

	handleRouteMode: function() {
		this.state.routeMode = !this.state.routeMode;
		if (!this.state.routeMode) {
			this.state.routePoints = [];
			this.state.routePath = [];
			if (this.state.polyline && this.state.map) {
				this.state.map.remove(this.state.polyline);
				this.state.polyline = null;
			}
		}
		this.syncRouteInfo();
	},

	handleGpxImport: function() {
		var input = document.getElementById('anygo-gpx-file');
		if (!input.files || !input.files.length)
			return common.notify('请选择 .gpx 文件', 'warning');
		var reader = new FileReader();
		reader.onload = L.bind(function() {
			var doc = new DOMParser().parseFromString(String(reader.result), 'application/xml');
			var nodes = doc.getElementsByTagName('trkpt');
			if (!nodes.length)
				nodes = doc.getElementsByTagName('rtept');
			var pts = [];
			for (var i = 0; i < nodes.length; i++) {
				var lat = parseFloat(nodes[i].getAttribute('lat'));
				var lon = parseFloat(nodes[i].getAttribute('lon'));
				if (!isNaN(lat) && !isNaN(lon))
					pts.push([ lat, lon ]);
			}
			if (pts.length < 2)
				return common.notify('GPX 中没有足够的轨迹点', 'warning');
			this.state.routePoints = pts;
			this.state.routePath = pts.map(function(p) {
				var g = wgs84ToGcj02(p[0], p[1]);
				return [ g[1], g[0] ];
			});
			this.state.routeMode = true;
			this.updatePolyline(true);
			this.syncRouteInfo();
			document.getElementById('anygo-lat').value = pts[0][0].toFixed(6);
			document.getElementById('anygo-lon').value = pts[0][1].toFixed(6);
			common.notify('已导入 ' + pts.length + ' 个 GPX 点', 'success');
		}, this);
		reader.readAsText(input.files[0]);
		input.value = '';
	},

	handleRouteStart: function() {
		var udids = this.selectedUuids();
		var pts = this.state.routePoints;
		if (!udids.length)
			return common.notify('请先勾选设备', 'warning');
		if (pts.length < 2)
			return common.notify('请先在地图上绘制至少 2 个点', 'warning');
		var speed = Number(document.getElementById('anygo-speed').value);
		if (!(speed > 0 && speed <= 100))
			return common.notify('速度须大于 0，且不超过 100 m/s', 'warning');
		var loop = document.getElementById('anygo-loop').checked;
		this.state.routeBusy = true;
		this.syncRouteInfo();
		callRouteStart(udids, pts, speed, loop).then(L.bind(function(res) {
			if (!res || !res.id)
				throw new Error(res && res.error || 'route_start failed');
			this.state.routeId = res.id;
			this.state.routeState = 'running';
			this.syncRouteInfo();
			common.notify('路线已开始', 'success');
		}, this)).catch(function(e) {
			common.notify('启动失败：' + e, 'danger');
		}).finally(L.bind(function() {
			this.state.routeBusy = false;
			this.syncRouteInfo();
		}, this));
	},

	handleRouteControl: function(action) {
		if (!this.state.routeId)
			return common.notify('当前没有路线', 'warning');
		callRouteControl(this.state.routeId, action).then(L.bind(function(res) {
			if (!res || !res.ok)
				throw new Error(res && (res.detail || res.error) || '操作失败');
			this.state.routeState = res.state;
			if (action === 'stop')
				this.state.routeId = null;
			this.syncRouteInfo();
		}, this)).catch(function(e) {
			common.notify(String(e), 'danger');
		});
	},

	handleRoutePause: function() { this.handleRouteControl('pause'); },
	handleRouteResume: function() { this.handleRouteControl('resume'); },
	handleRouteStop: function() { this.handleRouteControl('stop'); },

	handlePairUpload: function() {
		var input = document.getElementById('anygo-pair-file');
		if (!input.files || !input.files.length)
			return common.notify('请选择 .pair 文件', 'warning');
		var file = input.files[0];
		var reader = new FileReader();
		reader.onload = L.bind(function() {
			var b64 = String(reader.result).split(',')[1] || '';
			callPairImport(file.name, b64).then(L.bind(function(res) {
				if (!res || !res.udid)
					throw new Error((res && (res.detail || res.error)) || '导入失败');
				common.notify('已导入 ' + res.udid, 'success');
				this.state.selected.add(res.udid);
				this.refresh();
			}, this)).catch(function(e) {
				common.notify('导入失败：' + e, 'danger');
			});
		}, this);
		reader.readAsDataURL(file);
	},

	handlePairUsb: function() {
		var close = common.notify('请在 iPhone 上点“信任此电脑”，然后输入锁屏密码。', 'info');
		callPairUsb().then(L.bind(function(res) {
			if (!res || !res.udid)
				throw new Error((res && (res.detail || res.error)) || 'USB 配对失败');
			this.state.selected.add(res.udid);
			common.notify('USB 配对完成：' + res.udid, 'success');
			this.refresh();
		}, this)).catch(function(e) {
			common.notify('USB 配对失败：' + e, 'danger');
		}).finally(close);
	},

	handlePairDelete: function() {
		var udids = this.selectedUuids();
		if (!udids.length)
			return common.notify('请先勾选要删除的设备', 'warning');
		if (!confirm('确定删除所选设备的配对记录？删除后需要重新配对。'))
			return;
		Promise.all(udids.map(function(u) { return callPairDelete(u); })).then(L.bind(function() {
			udids.forEach(function(u) { this.state.selected.delete(u); }, this);
			common.notify('已删除', 'success');
			this.refresh();
		}, this));
	}
});
