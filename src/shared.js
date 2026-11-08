// Future me: bump this every time there's a blocklist update, too, so that the
// entires are pruned
const CURRENT_STORAGE_VERSION = 4;

class EnabledHostnamesList {
  #set = new Set();
  #blocklistDisabled = false;

  async load() {
    const storage = await browser.storage.local.get(["enabledHostnames", "storageVersion", "blocklistDisabled"]);
    this.#blocklistDisabled = storage?.blocklistDisabled === true;

    if (storage?.enabledHostnames) {
      this.#set = new Set(storage.enabledHostnames);
    }

    // In V3, this addon switched from browser.storage.sync to browser.storage.local. In reality, this didn't make a
    // difference because .sync storage doesn't actually sync in Firefox yet.
    // But even if it did - it would make no sense. The set of sites that need a Chrome spoof on Mobile is very
    // different from the set of sites on Desktop. This code migrates the old sync storage data.
    if (storage?.storageVersion < 3) {
      const syncStorage = await browser.storage.sync.get();
      if (Object.keys(syncStorage).length > 0) {
        console.info("migrating old sync storage to local");

        await browser.storage.local.set(syncStorage);
        await browser.storage.sync.clear();

        if (syncStorage.enabledHostnames) {
          this.#set = new Set(syncStorage.enabledHostnames);
        }
      }
    }

    if (storage?.storageVersion < CURRENT_STORAGE_VERSION) {
      this.pruneBlockedDomains();
      await browser.storage.local.set({ storageVersion: CURRENT_STORAGE_VERSION });
      await this.#persist();
    }
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

  isBlocked(hostname) {
    if (this.#blocklistDisabled) {
      return false;
    }

    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    return BLOCKED_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
  }

  async add(hostname) {
    if (this.isBlocked(hostname)) {
      return false;
    }

    this.#set.add(hostname);
    await this.#persist();
    return true;
  }

  async tryToggleBlocklist(input) {
    if (input.toLowerCase().trim() !== BLOCKLIST_BYPASS_PHRASE) {
      return false;
    }

    await this.setBlocklistDisabled(!this.#blocklistDisabled);
    return true;
  }

  async setBlocklistDisabled(disabled) {
    this.#blocklistDisabled = disabled;
    await browser.storage.local.set({ blocklistDisabled: this.#blocklistDisabled });

    if (!disabled) {
      this.pruneBlockedDomains();
      await this.#persist();
    }
  }

  isBlocklistDisabled() {
    return this.#blocklistDisabled;
  }

  pruneBlockedDomains() {
    for (const domain of this.#set) {
      if (this.isBlocked(domain)) {
        this.#set.delete(domain);
      }
    }
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

// Domains (including all of their subdomains) that Chrome Mask refuses to work on.
const BLOCKED_DOMAINS = [
  "google.ad",
  "google.ae",
  "google.al",
  "google.am",
  "google.as",
  "google.at",
  "google.az",
  "google.ba",
  "google.be",
  "google.bf",
  "google.bg",
  "google.bi",
  "google.bj",
  "google.bs",
  "google.bt",
  "google.by",
  "google.ca",
  "google.cat",
  "google.cd",
  "google.cf",
  "google.cg",
  "google.ch",
  "google.ci",
  "google.cl",
  "google.cm",
  "google.cn",
  "google.co.ao",
  "google.co.bw",
  "google.co.ck",
  "google.co.cr",
  "google.co.id",
  "google.co.il",
  "google.co.in",
  "google.co.jp",
  "google.co.ke",
  "google.co.kr",
  "google.co.ls",
  "google.co.ma",
  "google.co.mz",
  "google.co.nz",
  "google.co.th",
  "google.co.tz",
  "google.co.ug",
  "google.co.uk",
  "google.co.uz",
  "google.co.ve",
  "google.co.vi",
  "google.co.za",
  "google.co.zm",
  "google.co.zw",
  "google.com.af",
  "google.com.ag",
  "google.com.ar",
  "google.com.au",
  "google.com.bd",
  "google.com.bh",
  "google.com.bn",
  "google.com.bo",
  "google.com.br",
  "google.com.bz",
  "google.com.co",
  "google.com.cu",
  "google.com.cy",
  "google.com.do",
  "google.com.ec",
  "google.com.eg",
  "google.com.et",
  "google.com.fj",
  "google.com.gh",
  "google.com.gi",
  "google.com.gt",
  "google.com.hk",
  "google.com.jm",
  "google.com.kh",
  "google.com.kw",
  "google.com.lb",
  "google.com.ly",
  "google.com.mm",
  "google.com.mt",
  "google.com.mx",
  "google.com.my",
  "google.com.na",
  "google.com.ng",
  "google.com.ni",
  "google.com.np",
  "google.com.om",
  "google.com.pa",
  "google.com.pe",
  "google.com.pg",
  "google.com.ph",
  "google.com.pk",
  "google.com.pr",
  "google.com.py",
  "google.com.qa",
  "google.com.sa",
  "google.com.sb",
  "google.com.sg",
  "google.com.sl",
  "google.com.sv",
  "google.com.tj",
  "google.com.tr",
  "google.com.tw",
  "google.com.ua",
  "google.com.uy",
  "google.com.vc",
  "google.com.vn",
  "google.com",
  "google.cv",
  "google.cz",
  "google.de",
  "google.dj",
  "google.dk",
  "google.dm",
  "google.dz",
  "google.ee",
  "google.es",
  "google.fi",
  "google.fm",
  "google.fr",
  "google.ga",
  "google.ge",
  "google.gg",
  "google.gl",
  "google.gm",
  "google.gr",
  "google.gy",
  "google.hn",
  "google.hr",
  "google.ht",
  "google.hu",
  "google.ie",
  "google.im",
  "google.iq",
  "google.is",
  "google.it",
  "google.je",
  "google.jo",
  "google.kg",
  "google.ki",
  "google.kz",
  "google.la",
  "google.li",
  "google.lk",
  "google.lt",
  "google.lu",
  "google.lv",
  "google.md",
  "google.me",
  "google.mg",
  "google.mk",
  "google.ml",
  "google.mn",
  "google.mu",
  "google.mv",
  "google.mw",
  "google.ne",
  "google.nl",
  "google.no",
  "google.nr",
  "google.nu",
  "google.pl",
  "google.pn",
  "google.ps",
  "google.pt",
  "google.ro",
  "google.rs",
  "google.ru",
  "google.rw",
  "google.sc",
  "google.se",
  "google.sh",
  "google.si",
  "google.sk",
  "google.sm",
  "google.sn",
  "google.so",
  "google.sr",
  "google.st",
  "google.td",
  "google.tg",
  "google.tl",
  "google.tm",
  "google.tn",
  "google.to",
  "google.tt",
  "google.vu",
  "google.ws",
  "youtube.com",
];

const BLOCKLIST_BYPASS_PHRASE = "i will not complain about broken sites, open bug reports, or leave bad reviews.";
