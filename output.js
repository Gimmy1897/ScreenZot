Snap.run = async function(action, reader, doc, rect, shape) {
  try {
    const blob = await this.capture(doc, rect, shape);
    if (!blob) {
      this.notify("The selection does not include any page.", doc);
      return;
    }
    if (action === "copy") {
      const ok = await this.copyToClipboard(blob);
      if (ok) this.notify("Snapshot copied to clipboard", doc);
      else this.notify("Copy failed", doc);
    } else if (action === "save") {
      const ok = await this.saveToFile(blob, reader);
      if (ok) this.notify("Snapshot saved", doc);
    } else if (action === "note") {
      await this.addToNote(blob, reader, rect);
      this.notify("Snapshot added to a new note", doc);
    }
  } catch (e) {
    Zotero.logError(e);
    this.notify("Error: " + (e && e.message ? e.message : e), doc);
  }
};

Snap.copyToClipboard = async function(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const container = imgTools.decodeImageFromArrayBuffer(bytes.buffer, "image/png");
    const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    trans.init(null);
    trans.addDataFlavor("image/png");
    trans.setTransferData("image/png", container);
    Services.clipboard.setData(trans, null, Services.clipboard.kGlobalClipboard);
    return true;
  } catch (e) {
    try { Zotero.logError("[PDF Snapshot] copy: " + e); } catch (ex) {}
    return false;
  }
};

Snap.saveToFile = async function(blob, reader) {
  const { FilePicker } = ChromeUtils.importESModule(
    "chrome://zotero/content/modules/filePicker.mjs"
  );
  const fp = new FilePicker();
  fp.init(Zotero.getMainWindow(), "Save snapshot", fp.modeSave);
  fp.appendFilter("PNG", "*.png");
  const base = (reader._item?.getDisplayTitle?.() || "snapshot")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  fp.defaultString = `${base} ${stamp}.png`;
  const rv = await fp.show();
  if (rv !== fp.returnOK && rv !== fp.returnReplace) return false;
  let path;
  try {
    const f = fp.file;
    if (f && typeof f === "object") {
      if (typeof f.path === "string") path = f.path;
      else if (f.QueryInterface) {
        const nsf = f.QueryInterface(Ci.nsIFile);
        path = nsf.path;
      } else {
        path = String(f);
      }
    } else {
      path = String(f);
    }
  } catch (e) {
    Zotero.logError(e);
    path = fp.file;
  }
  if (typeof path !== "string") path = String(path);
  if (!/\.png$/i.test(path)) path += ".png";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    await IOUtils.write(path, bytes);
  } catch (e) {
    Zotero.logError(e);
    throw e;
  }
  return true;
};

Snap.addToNote = async function(blob, reader, rect) {
  const attachment = reader._item;
  const note = new Zotero.Item("note");
  note.libraryID = attachment.libraryID;
  if (attachment.parentID) note.parentID = attachment.parentID;
  note.setNote("");
  await note.saveTx();

  const img = await Zotero.Attachments.importEmbeddedImage({
    blob,
    parentItemID: note.id,
  });
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  note.setNote(
    `<div data-schema-version="9"><p><img data-attachment-key="${img.key}" width="${w}" height="${h}" alt=""/></p></div>`
  );
  await note.saveTx();
};

Snap.notify = function(msg, doc) {
  let shown = false;
  if (doc) {
    try {
      this.toast(doc, msg);
      shown = true;
    } catch (e) {
      Zotero.debug("[PDF Snapshot] in-page toast failed: " + e);
    }
  }
  let native = true;
  try {
    native = Zotero.Prefs.get(this.PREF_NATIVE, true) !== false;
  } catch (e) {}
  if (native) {
    try {
      const svc = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      svc.showAlertNotification(null, "PDF Snapshot", msg, false, "", null, "pdf-snapshot");
      shown = true;
    } catch (e) {
      Zotero.debug("[PDF Snapshot] system notification unavailable: " + e);
    }
  }
  if (!shown) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("PDF Snapshot");
      pw.addDescription(msg);
      pw.show();
      pw.startCloseTimer(2500);
    } catch (e) {
      Zotero.debug("[PDF Snapshot] " + msg);
    }
  }
};

Snap.toast = function(doc, msg) {
  const old = doc.getElementById("pdf-snapshot-toast");
  if (old) old.remove();
  const t = doc.createElement("div");
  t.id = "pdf-snapshot-toast";
  t.textContent = msg;
  t.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;" +
    "padding:9px 16px;border-radius:8px;background:#202124;color:#fff;" +
    "font:13px system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.45);" +
    "pointer-events:none;opacity:0;transition:opacity .15s;";
  doc.body.append(t);
  const win = doc.defaultView;
  win.requestAnimationFrame(() => (t.style.opacity = "1"));
  win.setTimeout(() => {
    t.style.opacity = "0";
    win.setTimeout(() => t.remove(), 200);
  }, 2200);
};
