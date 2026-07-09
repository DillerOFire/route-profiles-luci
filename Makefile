include $(TOPDIR)/rules.mk

PKG_NAME:=vpn-switch
PKG_VERSION:=2.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=slopfire
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/vpn-switch
  SECTION:=net
  CATEGORY:=Network
  TITLE:=VPN Switch (TOML profile routing)
  URL:=https://github.com/slopfire/vpn-switch-luci
  DEPENDS:=+libuci +nftables +rpcd-mod-file +luci-base +ca-bundle
  PKGARCH:=all
endef

define Package/vpn-switch/description
  Switch router routing policy using TOML profiles (default DIRECT).
  Each profile can set the default route plus optional selective domain
  routing (multiple devices) and GeoIP WAN bypass. Includes a LuCI web interface.
endef

define Package/vpn-switch/conffiles
/etc/config/vpn-switch
/etc/vpn-switch/profiles/
/etc/vpn-switch/cache/
endef

define Build/Compile
endef

define Package/vpn-switch/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/vpn-switch $(1)/usr/bin/vpn-switch

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/vpn-switch $(1)/etc/init.d/vpn-switch

	$(INSTALL_DIR) $(1)/etc/vpn-switch/profiles
	$(INSTALL_DATA) ./files/etc/vpn-switch/profiles/direct.toml $(1)/etc/vpn-switch/profiles/direct.toml
	$(INSTALL_DATA) ./files/etc/vpn-switch/profiles/brr.example.toml $(1)/etc/vpn-switch/profiles/brr.example.toml

	$(INSTALL_DIR) $(1)/etc/vpn-switch/cache

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/vpn-switch $(1)/etc/config/vpn-switch

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-vpnswitch.json $(1)/usr/share/luci/menu.d/luci-vpnswitch.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-vpnswitch.json $(1)/usr/share/rpcd/acl.d/luci-vpnswitch.json

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/network
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/network/vpnswitch.js $(1)/www/luci-static/resources/view/network/vpnswitch.js
endef

define Package/vpn-switch/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	mkdir -p /etc/vpn-switch/profiles /etc/vpn-switch/cache

	# Preserve 1.x setup as TOML, clean runtime, apply DIRECT
	if [ -x /usr/bin/vpn-switch ]; then
		/usr/bin/vpn-switch migrate-legacy || true
	fi

	# Remove leftover 1.x helper scripts if present
	rm -f /usr/bin/vpn-ai-update /usr/bin/vpn-geoip-update 2>/dev/null || true

	# Replace old crons with single update job
	if [ -f /etc/crontabs/root ]; then
		grep -vF '/usr/bin/vpn-switch ai-route update' /etc/crontabs/root 2>/dev/null | \
			grep -vF '/usr/bin/vpn-switch geoip update' | \
			grep -vF '/usr/bin/vpn-switch update' > /etc/crontabs/root.new || true
		mv /etc/crontabs/root.new /etc/crontabs/root
	fi
	CRON='*/30 * * * * /usr/bin/vpn-switch update >/dev/null 2>&1'
	if ! grep -qF "$$CRON" /etc/crontabs/root 2>/dev/null; then
		echo "$$CRON" >> /etc/crontabs/root
	fi
	/etc/init.d/cron restart 2>/dev/null || true

	# Enable boot apply
	/etc/init.d/vpn-switch enable 2>/dev/null || true
	/etc/init.d/rpcd restart 2>/dev/null || true
	/etc/init.d/uhttpd restart 2>/dev/null || true
fi
exit 0
endef

define Package/vpn-switch/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	if [ -f /etc/crontabs/root ]; then
		grep -vF '/usr/bin/vpn-switch update' /etc/crontabs/root > /etc/crontabs/root.new 2>/dev/null || true
		mv /etc/crontabs/root.new /etc/crontabs/root
		/etc/init.d/cron restart 2>/dev/null || true
	fi
	/etc/init.d/vpn-switch disable 2>/dev/null || true
	/etc/init.d/vpn-switch stop 2>/dev/null || true
	[ -x /usr/bin/vpn-switch ] && /usr/bin/vpn-switch teardown 2>/dev/null || true
fi
exit 0
endef

$(eval $(call BuildPackage,vpn-switch))
