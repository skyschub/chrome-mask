class EnabledHostnamesList {
  #set = new Set();

  async load() {
    const storage = await browser.storage.local.get(["enabledHostnames", "storageVersion"]);
    if (storage?.enabledHostnames) {
      this.#set = new Set(storage.enabledHostnames);
      return;
    }

    // In V3, this addon switched from browser.storage.sync to browser.storage.local. In reality, this didn't make a
    // difference because .sync storage doesn't actually sync in Firefox yet.
    // But even if it did - it would make no sense. The set of sites that need a Chrome spoof on Mobile is very
    // different from the set of sites on Desktop. This code migrates the old sync storage data.

    if (storage?.storageVersion >= 3) {
      return;
    }

    const syncStorage = await browser.storage.sync.get();
    if (Object.keys(syncStorage).length > 0) {
      console.info("migrating old sync storage to local");

      await browser.storage.local.set(syncStorage);
      await browser.storage.sync.clear();

      if (syncStorage.enabledHostnames) {
        this.#set = new Set(syncStorage.enabledHostnames);
      }
    }

    await browser.storage.local.set({ storageVersion: 3 });
  }

  async #persist() {
    const enabledHostnames = Array.from(this.#set.values());
    await browser.storage.local.set({ enabledHostnames });

    try {
      await browser.runtime.sendMessage({ action: "enabled_hostnames_changed" });
    } catch (ex) {
      console.error("Failed to send enabled_hostnames_changed message:", ex);
    }
  }

  async add(hostname) {
    this.#set.add(hostname);
    await this.#persist();
  }

  async remove(hostname) {
    this.#set.delete(hostname);
    await this.#persist();
  }

  async clear() {
    this.#set.clear();
    await this.#persist();
  }

  contains(hostname) {
    return this.#set.has(hostname);
  }

  get_values() {
    return this.#set.values();
  }

  size() {
    return this.#set.size;
  }
}

class ChromeUAStringManager {
  #remoteUrl = "https://chrome-mask-remote-storage.0b101010.services/current-chrome-major-version.txt";

  // This are just fallbacks in the case we somehow have to make a request before everything is loaded.
  #currentChromeVersion = "148";
  #currentPlatform = "win";
  #currentUAString = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36`;

  async init() {
    const platformInfo = await browser.runtime.getPlatformInfo();
    this.#currentPlatform = platformInfo.os;

    // On Linux, we actually spoof as Chrome-on-Windows. Some sites block Linux
    // specifically, so this is one general way to get around that. We can
    // narrow it durn further for the in-product intervention if needed.
    if (this.#currentPlatform == "linux") {
      this.#currentPlatform = "win";
    }

    await this.buildUAStringFromStorage();

    window.setInterval(
      async () => {
        await this.maybeRefreshRemote();
      },
      60 * 60 * 1000,
    );
    await this.maybeRefreshRemote();
  }

  getChromeVersion() {
    return this.#currentChromeVersion;
  }

  getCHMobile() {
    if (this.#currentPlatform == "android") {
      return "?1";
    }
    return "?0";
  }

  getCHPlatform() {
    return {
      win: "Windows",
      mac: "macOS",
      android: "Android",
    }[this.#currentPlatform];
  }

  getUAString() {
    return this.#currentUAString;
  }

  async buildUAStringFromStorage() {
    const storedMajorVersion = (await browser.storage.local.get("remoteStorageVersionNumber"))
      ?.remoteStorageVersionNumber?.version;
    if (storedMajorVersion) {
      this.#currentChromeVersion = storedMajorVersion;
    }

    const ChromeUAStrings = {
      win: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.#currentChromeVersion}.0.0.0 Safari/537.36`,
      mac: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.#currentChromeVersion}.0.0.0 Safari/537.36`,
      android: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.#currentChromeVersion}.0.0.0 Mobile Safari/537.36`,
    };

    this.#currentUAString = ChromeUAStrings[this.#currentPlatform];
  }

  async maybeRefreshRemote() {
    const updatedAt = (await browser.storage.local.get("remoteStorageVersionNumber"))?.remoteStorageVersionNumber
      ?.updatedAt;

    if (updatedAt > Date.now() - 24 * 60 * 60 * 1000) {
      console.info("remote updated in the last 24h, bailing");
      return;
    }

    try {
      const remoteResponseRaw = await fetch(this.#remoteUrl);
      if (remoteResponseRaw.status !== 200) {
        console.error("failed to update remote, unexpected status code", remoteResponseRaw.status);
        return;
      }

      const remoteResponse = await remoteResponseRaw.text();
      await browser.storage.local.set({
        remoteStorageVersionNumber: {
          version: remoteResponse.trim(),
          updatedAt: Date.now(),
        },
      });

      this.buildUAStringFromStorage();
    } catch (ex) {
      console.error("failed to update remote", ex);
    }
  }
}
