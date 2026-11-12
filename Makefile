include $(TOPDIR)/rules.mk

PKG_VERSION:=1.0.1
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for AnyGo iPhone location simulation
LUCI_DESCRIPTION:=Manage simulated GPS locations for iPhones on the same LAN
LUCI_DEPENDS:=+luci-base +rpcd +uhttpd-mod-ubus +curl +jsonfilter +flock +kmod-tun +libusb-1.0 +libopenssl +zlib
LUCI_PKGARCH:=all

ifneq ($(ANYGO_VERSION),)
  PKG_VERSION:=$(ANYGO_VERSION)
endif

define Package/luci-app-anygo/conffiles
/etc/config/anygo
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
