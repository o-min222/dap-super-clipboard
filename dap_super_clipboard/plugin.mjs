/**
 * Super Clipboard — DAP 외부 플러그인 (main-side).
 *
 * 이 모듈은 DAP main 프로세스에서 `activate(ctx)`로 로드된다. 팔레트 페이지(sandbox 렌더러)는
 * `ctx.host`에 직접 못 닿으므로, 모든 특권 작업(히스토리 읽기·blob 저장·paste)은 여기서 하고
 * 팔레트와는 message 프로토콜로만 통신한다.
 *
 * message 프로토콜:
 *   main → palette : { type:"items", items:PaletteCard[] }
 *   palette → main : { type:"ready" | "paste" | "delete" | "pin" | "unpin" | "clearAll", id? }
 *
 * PaletteCard = { id, kind:"text"|"image", createdAt, pinned, preview, imageUrl? }
 *
 * 자기완결 ESM — 외부 import 없음.
 */

export function activate(ctx) {
  const H = ctx.host;
  const historyApi = H.clipboardHistory; // 권한 clipboard.history
  const storage = H.storage; // 권한 storage.private
  const windows = H.windows; // 권한 window.palette
  const paste = H.paste; // 권한 input.synthesize

  /** 현재 열린 팔레트 핸들 (없으면 null). */
  let handle = null;
  /** historyId -> blobId. 같은 이미지를 매번 putBlob 하지 않도록 캐시. */
  const blobCache = new Map();

  const PINS_KEY = "pins";
  const ORDER_KEY = "order"; // 사용자가 드래그로 정한 카드 순서 (id 배열)
  const LIST_LIMIT = 100;

  async function readPins() {
    const pins = storage ? await storage.getJson(PINS_KEY) : null;
    return Array.isArray(pins) ? pins : [];
  }

  async function readOrder() {
    const order = storage ? await storage.getJson(ORDER_KEY) : null;
    return Array.isArray(order) ? order : [];
  }

  /** 히스토리에서 사라진 이미지의 blob을 지워 누수를 막는다(TTL/캡 eviction 대응). */
  function pruneBlobs(liveIds) {
    for (const [historyId, blobId] of blobCache) {
      if (!liveIds.has(historyId)) {
        if (storage) void storage.deleteBlob(blobId);
        blobCache.delete(historyId);
      }
    }
  }

  /** 이미지 히스토리 항목을 <img>에서 쓸 dap-blob:// URL로 변환(캐시). */
  async function ensureImageUrl(historyId) {
    if (!storage) return null;
    let blobId = blobCache.get(historyId);
    if (!blobId) {
      const full = await historyApi.get(historyId);
      if (!full || !full.imageBytes) return null;
      blobId = await storage.putBlob(full.imageBytes, { mime: "image/png" });
      blobCache.set(historyId, blobId);
    }
    return storage.blobUrl(blobId);
  }

  /**
   * 히스토리 + 핀 + 사용자 순서를 병합해 팔레트 카드 목록을 만든다.
   * 정렬 규칙: 핀 먼저 → 저장된 순서(order)에 있으면 그 위치 → 새 항목(order에 없음)은 최상단 최신순.
   */
  async function buildCards() {
    const [items, pins, order] = await Promise.all([
      historyApi.list({ limit: LIST_LIMIT }),
      readPins(),
      readOrder(),
    ]);
    const pinSet = new Set(pins);
    const orderIdx = new Map(order.map((id, i) => [id, i]));
    const liveIds = new Set(items.map((it) => it.id));
    pruneBlobs(liveIds);

    const cards = [];
    for (const it of items) {
      const card = {
        id: it.id,
        kind: it.kind,
        createdAt: it.createdAt,
        pinned: pinSet.has(it.id),
        preview: it.preview,
      };
      if (it.kind === "text" && typeof it.text === "string") card.text = it.text; // 드래그 export용 전체 텍스트
      if (it.kind === "image") card.imageUrl = await ensureImageUrl(it.id);
      if (it.kind === "files" && Array.isArray(it.files)) card.files = it.files; // 드래그 export용 파일 경로
      cards.push(card);
    }
    cards.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ai = orderIdx.has(a.id) ? orderIdx.get(a.id) : -1;
      const bi = orderIdx.has(b.id) ? orderIdx.get(b.id) : -1;
      if (ai === -1 && bi === -1) return b.createdAt - a.createdAt; // 둘 다 새 항목 → 최신순
      if (ai === -1) return -1; // a가 새 항목 → 위로
      if (bi === -1) return 1; // b가 새 항목 → 위로
      return ai - bi; // 저장된 순서
    });
    return cards;
  }

  async function pushItems() {
    if (!handle || handle.isDestroyed()) return;
    handle.postMessage({ type: "items", items: await buildCards() });
  }

  function openPalette() {
    // open() 시점에 "직전 포커스 앱"이 paste 타깃으로 캡처된다 → 토글마다 재오픈해야 정확.
    handle = windows.openPalette({ page: "palette/index.html", width: 360, height: 520 });
    handle.onMessage(onPaletteMessage);
  }

  function closePalette() {
    if (handle && !handle.isDestroyed()) handle.close();
    handle = null;
  }

  function togglePalette() {
    if (handle && !handle.isDestroyed()) closePalette();
    else openPalette();
  }

  async function pasteById(id) {
    const full = await historyApi.get(id);
    if (full && full.kind === "text" && typeof full.text === "string") {
      paste.pasteItem({ kind: "text", text: full.text });
      // 팔레트는 열어둔다 — 여러 항목을 그때그때 연속으로 꺼내 쓸 수 있게(사용자 요청 핵심 UX).
      if (handle && !handle.isDestroyed()) handle.postMessage({ type: "pasted", id });
    }
    // 이미지 paste는 호스트 후속(dragdrop.export). 지금은 텍스트만 paste.
  }

  async function togglePin(id, on) {
    if (!storage) return;
    const set = new Set(await readPins());
    if (on) set.add(id);
    else set.delete(id);
    await storage.setJson(PINS_KEY, [...set]);
    await pushItems();
  }

  /** 팔레트가 보낸 새 표시 순서(id 배열)를 저장. 유효한(존재하는) id만 남긴다. */
  async function saveOrder(ids) {
    if (!storage || !Array.isArray(ids)) return;
    const live = new Set((await historyApi.list({ limit: LIST_LIMIT })).map((it) => it.id));
    await storage.setJson(ORDER_KEY, ids.filter((id) => live.has(id)));
    await pushItems();
  }

  async function onPaletteMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        await pushItems();
        break;
      case "paste":
        await pasteById(msg.id);
        break;
      case "delete":
        await historyApi.remove(msg.id);
        blobCache.delete(msg.id);
        await pushItems();
        break;
      case "pin":
        await togglePin(msg.id, true);
        break;
      case "unpin":
        await togglePin(msg.id, false);
        break;
      case "reorder":
        await saveOrder(msg.ids);
        break;
      case "clearAll":
        await historyApi.clearAll();
        blobCache.clear();
        await pushItems();
        break;
      default:
        break;
    }
  }

  // 트리거 1: 펫 래디얼 메뉴 → togglePalette 액션.
  ctx.actions.registerAction({ id: "togglePalette", callback: () => togglePalette() });
  ctx.radialMenu.addItem({
    itemId: "palette",
    label: "클립보드",
    actionId: "togglePalette",
    icon: "assets/clip.svg", // 플러그인 dir 기준 경로 — 호스트가 읽어 data URL로 래디얼에 표시
  });

  // 트리거 2: 전역 단축키 — 호스트 정식 shortcut 기여 API로 등록한다.
  // 레거시 ctx.host.hotkey.register(globalShortcut 직행)는 코어 hotkey 재등록 때
  // globalShortcut.unregisterAll()에 함께 쓸려 사라지고 복구되지 않는다. 정식 경로(shortcutStore)는
  // pluginShortcuts.reregister()로 같이 재등록되고, 설정에서 리바인딩도 된다.
  // modifiers 비트마스크: Alt=1 / Control=2 / Shift=4. vk: 'V'=86.
  // mac에서는 Control 기반(⌃⇧V) — 이 API엔 Command 비트가 없다(원하면 설정에서 변경).
  const MOD_CONTROL = 2, MOD_SHIFT = 4;
  if (ctx.shortcuts && typeof ctx.shortcuts.registerShortcut === "function") {
    ctx.shortcuts.registerShortcut({
      actionKey: "togglePalette",
      title: "슈퍼 클립보드 열기/닫기",
      defaultModifiers: MOD_CONTROL | MOD_SHIFT,
      defaultVk: 86, // 'V'
      actionId: "togglePalette",
    });
  }

  // 히스토리 변화(복사/삭제) 시 열린 팔레트를 갱신.
  const disposeChanged = historyApi.onChanged(() => {
    void pushItems();
  });

  // cleanup — registration(actions/radial/shortcut)은 ctx가 자동 dispose. 창/구독만 정리.
  return () => {
    if (typeof disposeChanged === "function") disposeChanged();
    closePalette();
    blobCache.clear();
  };
}
