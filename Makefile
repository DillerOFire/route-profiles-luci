include $(TOPDIR)/rules.mk

PKG_NAME:=route-profiles
PKG_VERSION:=2.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=DillerOFire
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/route-profiles
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Route Profiles (TOML profile routing)
  URL:=https://github.com/DillerOFire/route-profiles-luci
  DEPENDS:=+libuci +nftables +rpcd-mod-file +luci-base +ca-bundle
  PKGARCH:=all
endef

define Package/route-profiles/description
  Manage OpenWrt routing policy with TOML profiles (default DIRECT).
  Each profile can set the default route plus optional selective domain
  routing (multiple devices) and GeoIP WAN bypass. Includes a LuCI UI.
endef

define Package/route-profiles/conffiles
/etc/config/route-profiles
/etc/route-profiles/profiles/
/etc/route-profiles/cache/
endef

define Build/Compile
endef

define Package/route-profiles/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/route-profiles $(1)/usr/bin/route-profiles

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/route-profiles $(1)/etc/init.d/route-profiles

	$(INSTALL_DIR) $(1)/etc/route-profiles/profiles
	$(INSTALL_DATA) ./files/etc/route-profiles/profiles/direct.toml $(1)/etc/route-profiles/profiles/direct.toml
	$(INSTALL_DATA) ./files/etc/route-profiles/profiles/brr.example.toml $(1)/etc/route-profiles/profiles/brr.example.toml

	$(INSTALL_DIR) $(1)/etc/route-profiles/cache

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/route-profiles $(1)/etc/config/route-profiles

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-routeprofiles.json $(1)/usr/share/luci/menu.d/luci-routeprofiles.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-routeprofiles.json $(1)/usr/share/rpcd/acl.d/luci-routeprofiles.json

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/network
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/network/routeprofiles.js $(1)/www/luci-static/resources/view/network/routeprofiles.js
endef

define Package/route-profiles/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	mkdir -p /etc/route-profiles/profiles /etc/route-profiles/cache

	# Import vpn-switch / 1.x setup if present, clean runtime, apply DIRECT
	if [ -x /usr/bin/route-profiles ]; then
		/usr/bin/route-profiles migrate-legacy || true
	fi

	# Remove leftover 1.x / old-package helpers
	rm -f /usr/bin/vpn-ai-update /usr/bin/vpn-geoip-update /usr/bin/vpn-switch 2>/dev/null || true
	rm -f /etc/init.d/vpn-switch 2>/dev/null || true

	# Replace old crons (vpn-switch + route-profiles) with single update job
	if [ -f /etc/crontabs/root ]; then
		grep -vF '/usr/bin/vpn-switch' /etc/crontabs/root 2>/dev/null | \
			grep -vF '/usr/bin/route-profiles' > /etc/crontabs/root.new || true
		mv /etc/crontabs/root.new /etc/crontabs/root
	fi
	CRON='*/30 * * * * /usr/bin/route-profiles update >/dev/null 2>&1'
	if ! grep -qF "$$CRON" /etc/crontabs/root 2>/dev/null; then
		echo "$$CRON" >> /etc/crontabs/root
	fi
	/etc/init.d/cron restart 2>/dev/null || true

	# Enable boot apply
	/etc/init.d/route-profiles enable 2>/dev/null || true
	/etc/init.d/rpcd restart 2>/dev/null || true
	/etc/init.d/uhttpd restart 2>/dev/null || true
fi
exit 0
endef

define Package/route-profiles/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	if [ -f /etc/crontabs/root ]; then
		grep -vF '/usr/bin/route-profiles update' /etc/crontabs/root > /etc/crontabs/root.new 2>/dev/null || true
		mv /etc/crontabs/root.new /etc/crontabs/root
		/etc/init.d/cron restart 2>/dev/null || true
	fi
	/etc/init.d/route-profiles disable 2>/dev/null || true
	/etc/init.d/route-profiles stop 2>/dev/null || true
	[ -x /usr/bin/route-profiles ] && /usr/bin/route-profiles teardown 2>/dev/null || true
fi
exit 0
endef

$(eval $(call BuildPackage,route-profiles))
