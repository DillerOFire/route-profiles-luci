include $(TOPDIR)/rules.mk

PKG_NAME:=route-profiles
PKG_VERSION:=2.2.0
PKG_RELEASE:=2

PKG_MAINTAINER:=DillerOFire
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

# ---------------------------------------------------------------------------
# Rust target triple for the OpenWrt ARCH being built
# ---------------------------------------------------------------------------
ifeq ($(ARCH),x86_64)
  RUSTC_TARGET_ARCH:=x86_64-unknown-linux-musl
else ifeq ($(ARCH),i386)
  RUSTC_TARGET_ARCH:=i686-unknown-linux-musl
else ifeq ($(ARCH),aarch64)
  RUSTC_TARGET_ARCH:=aarch64-unknown-linux-musl
else ifeq ($(ARCH),arm)
  ifneq ($(findstring v5,$(CONFIG_CPU_TYPE)$(CPU_TYPE)),)
    RUSTC_TARGET_ARCH:=armv5te-unknown-linux-musleabi
  else ifneq ($(CONFIG_HAS_FPU),)
    RUSTC_TARGET_ARCH:=armv7-unknown-linux-musleabihf
  else
    RUSTC_TARGET_ARCH:=armv7-unknown-linux-musleabi
  endif
else ifeq ($(ARCH),mips)
  RUSTC_TARGET_ARCH:=mips-unknown-linux-musl
else ifeq ($(ARCH),mipsel)
  RUSTC_TARGET_ARCH:=mipsel-unknown-linux-musl
else ifeq ($(ARCH),mips64)
  RUSTC_TARGET_ARCH:=mips64-unknown-linux-muslabi64
else ifeq ($(ARCH),mips64el)
  RUSTC_TARGET_ARCH:=mips64el-unknown-linux-muslabi64
else ifeq ($(ARCH),riscv64)
  RUSTC_TARGET_ARCH:=riscv64gc-unknown-linux-musl
else ifeq ($(ARCH),powerpc)
  RUSTC_TARGET_ARCH:=powerpc-unknown-linux-musl
else ifeq ($(ARCH),powerpc64)
  RUSTC_TARGET_ARCH:=powerpc64-unknown-linux-musl
else
  RUSTC_TARGET_ARCH:=$(ARCH)-unknown-linux-musl
endif

CARGO_HOME_DIR:=$(DL_DIR)/route-profiles-cargo-home
RUSTUP_HOME_DIR:=$(DL_DIR)/route-profiles-rustup-home
GEOEXTRACT_BIN:=$(PKG_BUILD_DIR)/target/$(RUSTC_TARGET_ARCH)/release/route-profiles-geoextract
# CI can drop a prebuilt binary here (skips rustc inside SDK — much faster)
PREBUILT_GEOEXTRACT:=$(CURDIR)/prebuilt/route-profiles-geoextract

define Package/route-profiles
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Route Profiles (TOML profile routing)
  URL:=https://github.com/DillerOFire/route-profiles-luci
  DEPENDS:=+libuci +nftables +rpcd-mod-file +luci-base +ca-bundle
endef

define Package/route-profiles/description
  Manage OpenWrt routing policy with TOML profiles (default DIRECT).
  Each profile can set the default route plus optional selective domain
  routing (multiple devices) and GeoIP WAN bypass. Includes a LuCI UI.
  Ships route-profiles-geoextract (Rust) for V2Fly/Xray .dat, sing-box
  .db and .srs binary lists.
endef

define Package/route-profiles/conffiles
/etc/config/route-profiles
/etc/route-profiles/profiles/
/etc/route-profiles/cache/
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./geoextract/. $(PKG_BUILD_DIR)/
	# Optional CI prebuilt (path is relative to package source / feed)
	if [ -f "$(PREBUILT_GEOEXTRACT)" ]; then \
		$(CP) "$(PREBUILT_GEOEXTRACT)" $(PKG_BUILD_DIR)/prebuilt-geoextract ; \
	fi
endef

# Prefer prebuilt binary from CI; otherwise bootstrap rustup and cross-build.
define Build/Compile
	mkdir -p $(dir $(GEOEXTRACT_BIN))
	if [ -f "$(PKG_BUILD_DIR)/prebuilt-geoextract" ]; then \
		echo "Using CI prebuilt route-profiles-geoextract" ; \
		$(CP) $(PKG_BUILD_DIR)/prebuilt-geoextract $(GEOEXTRACT_BIN) ; \
		chmod 755 $(GEOEXTRACT_BIN) ; \
	else \
		mkdir -p $(CARGO_HOME_DIR) $(RUSTUP_HOME_DIR) ; \
		export CARGO_HOME="$(CARGO_HOME_DIR)" ; \
		export RUSTUP_HOME="$(RUSTUP_HOME_DIR)" ; \
		export PATH="$(CARGO_HOME_DIR)/bin:$$$${PATH}" ; \
		if [ ! -x "$(CARGO_HOME_DIR)/bin/cargo" ]; then \
			echo "Installing rustup toolchain into $(CARGO_HOME_DIR) ..." ; \
			curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
				sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path ; \
		fi ; \
		export PATH="$(CARGO_HOME_DIR)/bin:$$$${PATH}" ; \
		rustup target add $(RUSTC_TARGET_ARCH) ; \
		cd $(PKG_BUILD_DIR) && \
		CARGO_HOME="$(CARGO_HOME_DIR)" \
		RUSTUP_HOME="$(RUSTUP_HOME_DIR)" \
		CC="$(TARGET_CC)" \
		cargo build --release --offline --target $(RUSTC_TARGET_ARCH) \
			--config 'net.offline=true' \
			--config 'target.$(RUSTC_TARGET_ARCH).linker="$(TARGET_CC)"' ; \
	fi
	test -x "$(GEOEXTRACT_BIN)"
endef

define Package/route-profiles/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/route-profiles $(1)/usr/bin/route-profiles
	$(INSTALL_BIN) $(GEOEXTRACT_BIN) $(1)/usr/bin/route-profiles-geoextract

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
	# Install cron job for domain/GeoIP refresh
	if [ -f /etc/crontabs/root ]; then
		grep -vF '/usr/bin/route-profiles' /etc/crontabs/root > /etc/crontabs/root.new 2>/dev/null || true
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
