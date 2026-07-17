const enabledHostnames = new EnabledHostnamesList();

async function initUi() {
  [
    ["add-site-hostname-explanation", "addSiteHostnameExplanation"],
    ["add-site-title", "addSiteTitle"],
    ["masked-sites-title", "maskedSitesTitle"],
    ["manage-sites-title", "manageSitesTitle"],
  ].forEach(([id, i18nKey]) => {
    document.getElementById(id).innerText = browser.i18n.getMessage(i18nKey);
  });

  document.getElementById("add-site-button").value = browser.i18n.getMessage("addSiteButton");

  setupAddForm();
  setupSiteList();
  setupManageSites();
  setupKeyboardShortcuts();
}

function tryValidateHostname(input) {
  // [ToDo] whenever ESR 115 is finally dead, use .parse() again.
  try {
    return new URL(input).hostname;
  } catch {}

  try {
    return new URL(`https://${input}`).hostname;
  } catch {}

  return undefined;
}

function setupAddForm() {
  const inputEl = document.getElementById("add-site-input");
  document.getElementById("add-site-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();

    const maybeHostname = tryValidateHostname(inputEl.value);
    if (!maybeHostname) {
      alert(browser.i18n.getMessage("addSiteErrorInvalid"));
      return false;
    }

    if (enabledHostnames.contains(maybeHostname)) {
      alert(browser.i18n.getMessage("addSiteErrorAlreadyActive"));
      return false;
    }

    await enabledHostnames.add(maybeHostname);
    inputEl.value = "";
    window.location.reload();
  });
}

function setupSiteList() {
  const siteList = document.getElementById("masked-sites");
  siteList.innerHTML = "";

  if (enabledHostnames.size() < 1) {
    const siteListItem = document.createElement("p");
    siteListItem.innerText = browser.i18n.getMessage("siteListEmpty");
    siteList.appendChild(siteListItem);
    return;
  }

  [...enabledHostnames.get_values()]
    .sort((a, b) => a.localeCompare(b))
    .forEach((hostname) => {
      const siteListItem = document.createElement("div");
      siteListItem.classList.add("site-list-item");

      const hostnameLabel = document.createElement("p");
      hostnameLabel.textContent = hostname;

      const deleteButton = document.createElement("button");
      deleteButton.textContent = browser.i18n.getMessage("siteListRemoveButton");
      deleteButton.addEventListener("click", async () => {
        await enabledHostnames.remove(hostname);
        window.location.reload();
      });

      siteListItem.append(hostnameLabel, deleteButton);
      siteList.appendChild(siteListItem);
    });
}

function handleImportFilepicker(ev) {
  const fileReaderOnLoadHandler = async function () {
    let result = this.result;
    if (typeof this.result !== "string" || this.result === "") {
      return;
    }
    const lines = result.split(/\r?\n/);
    for (const [index, val] of lines.entries()) {
      if (val === "") {
        continue;
      }
      const maybeHostname = tryValidateHostname(val);
      if (!maybeHostname) {
        alert(browser.i18n.getMessage("manageSitesImportError", [index + 1]));
        window.location.reload();
        break;
      }

      if (enabledHostnames.contains(maybeHostname)) {
        continue;
      }

      await enabledHostnames.add(maybeHostname);
    }
    window.location.reload();
  };
  const file = ev.target.files[0];
  if (file === undefined || file.name === "") {
    return;
  }
  if (file.type.indexOf("text") !== 0) {
    return;
  }
  const fr = new FileReader();
  fr.addEventListener("load", fileReaderOnLoadHandler);
  fr.readAsText(file);
}

function getExportDefaultFileName() {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  const datetime = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace("T", "_")
    .replace(/:/g, ".");
  return browser.i18n.getMessage("exportSitesDefaultFileName", [datetime]);
}

function setupManageSites() {
  const manageSitesExportButton = document.getElementById("manage-sites-export-button");
  manageSitesExportButton.textContent = browser.i18n.getMessage("manageSitesExportButton");

  const manageSitesImportButton = document.getElementById("manage-sites-import-button");
  manageSitesImportButton.textContent = browser.i18n.getMessage("manageSitesImportButton");
  manageSitesImportButton.addEventListener("click", async () => {
    const input = document.getElementById("manage-sites-import-filepicker");
    input.click();
  });

  const manageSitesImportFilepicker = document.getElementById("manage-sites-import-filepicker");
  manageSitesImportFilepicker.addEventListener("change", async (ev) => {
    handleImportFilepicker(ev);
  });

  if (enabledHostnames.size() < 1) {
    manageSitesExportButton.disabled = true;
    return;
  }

  manageSitesExportButton.addEventListener("click", async () => {
    const fileContent = [...enabledHostnames.get_values()].sort((a, b) => a.localeCompare(b)).join("\n");
    const blob = new Blob([fileContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    browser.downloads.download({
      url: url,
      filename: getExportDefaultFileName(),
      saveAs: true,
    });
  });
}

async function setupKeyboardShortcuts() {
  const platformInfo = await browser.runtime.getPlatformInfo();
  if (platformInfo.os == "android") return;

  const shortcutsTitle = document.getElementById("shortcuts-title");
  shortcutsTitle.textContent = browser.i18n.getMessage("shortcutsTitle");

  const shortcutsCommandCombo = document.getElementById("shortcuts-command-combo");
  shortcutsCommandCombo.textContent = browser.i18n.getMessage("shortcutsCommandCombo");

  const shortcutsCommandDescription = document.getElementById("shortcuts-command-description");
  shortcutsCommandDescription.textContent = browser.i18n.getMessage("shortcutsCommandDescription");

  const shortcutsCommandList = document.getElementById("shortcuts-command-list");
  const browserCommands = await browser.commands.getAll();
  browserCommands.forEach((browserCommand) => {
    const shortcutsCommandRow = document.createElement("tr");

    const shortcutsCommandItemShortcut = document.createElement("td");
    shortcutsCommandItemShortcut.textContent =
      browserCommand.shortcut || browser.i18n.getMessage("shortcutsCommandItemShortcutUndefined");

    const shortcutsCommandItemDescription = document.createElement("td");
    shortcutsCommandItemDescription.textContent = browserCommand.description;

    shortcutsCommandRow.append(shortcutsCommandItemShortcut, shortcutsCommandItemDescription);
    shortcutsCommandList.appendChild(shortcutsCommandRow);
  });

  const browserInfo = await browser.runtime.getBrowserInfo();
  const browserVersion = browserInfo.version.split(".")[0];

  if (browserVersion >= 137) {
    const shortcutsOpenPanelButton = document.getElementById("shortcuts-open-panel-button");
    shortcutsOpenPanelButton.textContent = browser.i18n.getMessage("shortcutsOpenPanelButton");
    shortcutsOpenPanelButton.addEventListener("click", async () => {
      if (browser.commands?.openShortcutSettings) {
        await browser.commands.openShortcutSettings();
      }
    });
    shortcutsOpenPanelButton.style.display = "block";
  }

  const shortcutsSection = document.getElementById("shortcuts-section");
  shortcutsSection.style.display = "block";
}

document.addEventListener("DOMContentLoaded", async () => {
  await enabledHostnames.load();
  await initUi();

  browser.runtime.onMessage.addListener(async (msg) => {
    switch (msg.action) {
      case "enabled_hostnames_changed":
        window.location.reload();
        break;
      default:
        throw new Error("unexpected message received", msg);
    }
  });
});
