# Super Clipboard — DAP 외부 플러그인 개발 플랜

> 대상: `<userData>/.deskpet/plugins/com.example.super_clipboard/` 에 설치되는 외부 플러그인
> 런타임: DAP(mydeskpet) Electron Plugin Host — **호스트 API는 이미 구현 완료(green)**
> 근거 브랜치: `mydeskpet@feat/super-clipboard-plugin-api` (Phase 0~4)
> 이 레포의 역할: 호스트 API를 **소비하는** 플러그인 그 자체. 호스트 코드는 건드리지 않는다.

---

## 0. 전제 — 이미 준비된 것 / 우리가 만들 것

**호스트가 제공(구현 완료):** `ctx.host` 아래 permission-gated 서비스
- `ctx.host.storage` — `getJson/setJson/delete/keys` + `putBlob/getBlob/blobUrl/deleteBlob/usage` (pluginId 격리, 500MB 캡)
- `ctx.host.clipboardHistory` — `list/get/remove/clearAll/onChanged` (읽기전용, text+image, 기본 OFF 옵트인)
- `ctx.host.windows.openPalette({page,width,height,frame})` → `PaletteHandle`
- `ctx.host.paste.pasteItem({kind:"text", text})` — 팔레트 열기 직전 포커스 앱에 Ctrl+V 합성 + 클립보드 원복
- `ctx.radialMenu.addItem` / `ctx.shortcuts.registerShortcut` / `ctx.trayMenu.addItem` — 팔레트 토글 트리거

**우리가 만들 것 (이 레포):**
1. `plugin.yaml` — manifest (permissions 선언)
2. `dap_super_clipboard/plugin.mjs` — `activate(ctx)` main-side 로직 (자기완결 ESM, bare import 금지)
3. `palette/index.html` — 팔레트 UI (인라인 CSS/JS, `window.dapPalette`만 사용)

---

## 1. 아키텍처 — 2프로세스 분리 (호스트가 강제하는 구조)

```
┌─ MAIN 프로세스 ─────────────┐        ┌─ 팔레트 렌더러(sandbox) ──────┐
│ plugin.mjs  activate(ctx)   │        │ palette/index.html            │
│                             │        │                               │
│ ctx.host.clipboardHistory ──┼─data──▶│ window.dapPalette.onMessage   │
│ ctx.host.storage (blob)     │postMsg │   → 카드 렌더                  │
│ ctx.host.paste.pasteItem  ◀─┼─cmd────│ window.dapPalette.postMessage │
│ ctx.host.windows.openPalette│        │   (paste/pin/delete 요청)      │
│ ctx.radialMenu / shortcuts  │        │ window.dapPalette.close()      │
└─────────────────────────────┘        └───────────────────────────────┘
```

**핵심 제약:** 팔레트 페이지는 `ctx.host`에 직접 접근 못 함. `window.dapPalette` = `{postMessage, onMessage, close}` 뿐.
→ **모든 특권 작업은 plugin.mjs(main)가 하고**, 팔레트와는 메시지 프로토콜로만 통신한다.
→ 이미지는 `clipboardHistory.get(id)`(bytes) → `storage.putBlob` → `blobUrl` = `dap-blob://…` URL을 팔레트에 넘겨 `<img src>`로 표시.

### 메시지 프로토콜 (우리가 정의) — plugin.mjs ↔ palette
```
main → palette (postMessage):
  { type: "items", items: PaletteCard[] }      // 전체 목록 갱신
  { type: "focus" }                            // 팔레트 떴을 때 검색창 포커스

palette → main (dapPalette.postMessage):
  { type: "paste", id }                        // 이 항목을 붙여넣어줘
  { type: "delete", id }                       // 히스토리에서 삭제
  { type: "pin", id } / { type: "unpin", id }  // 핀 토글 (storage)
  { type: "clearAll" }
  { type: "ready" }                            // 팔레트 로드 완료 → main이 items 푸시

PaletteCard = {
  id, kind: "text"|"image", createdAt, pinned,
  preview,            // 텍스트 앞부분 or "이미지 …"
  imageUrl?           // kind==="image"일 때 dap-blob:// URL
}
```

---

## 2. 데이터 흐름 (핵심 루프)

1. 사용자가 어디선가 복사 → 호스트 `clipboardHistory` 폴러가 캡처(옵트인 시).
2. `clipboardHistory.onChanged` 발화 → plugin.mjs가 `list()`로 최신 목록 조회.
3. 이미지 항목은 `get(id)`로 bytes → `storage.putBlob` → `blobUrl` 부여(캐시).
4. 핀 목록은 `storage.getJson("pins")`와 병합 → `PaletteCard[]` 구성 → 팔레트에 `{type:"items"}` postMessage.
5. 래디얼/단축키로 팔레트 toggle → 사용자가 카드 클릭 → 팔레트가 `{type:"paste", id}` 전송.
6. plugin.mjs: text면 `paste.pasteItem({kind:"text", text})` → 직전 포커스 앱에 붙여넣기 + 원복.

> **MVP 범위:** text paste는 완전 지원. 이미지는 **표시/관리는 되지만 paste는 후속**(호스트도 이미지 paste 미구현, dragExport도 Phase 5 후속). 이미지는 "미리보기 + 삭제 + (후속)드래그" 로 시작.

---

## 3. 파일별 구현 계획

### 3.1 `plugin.yaml`
```yaml
id: com.example.super_clipboard
name: Super Clipboard
version: 0.1.0
manifest_version: 2
entry: dap_super_clipboard.plugin:activate
author: dudal
description: 복사한 텍스트·이미지를 팔레트에 모아 클릭/드래그로 붙여넣는 슈퍼 클립보드.
surface: user
permissions:
  - clipboard.history      # 히스토리 읽기 (민감 — 사용자 옵트인 필요)
  - storage.private        # 핀/순서/blob 캐시
  - window.palette         # 팔레트 창
  - input.synthesize       # text paste
  # 후속: - dragdrop.export
execution_modes:
  - user
```
- entry `dap_super_clipboard.plugin:activate` → 파일 경로 `dap_super_clipboard/plugin.mjs`의 `export function activate`.
- ⚠️ **entry 모듈은 `.mjs` 확장자 필수** (호스트 `entryModulePath`가 `.mjs`로 리졸브, dir엔 package.json 없음).

### 3.2 `dap_super_clipboard/plugin.mjs` (main-side)
`export function activate(ctx)` — 반환값은 cleanup 함수. 구현 골격:
- 팔레트 핸들 lazy 생성: `ctx.host.windows.openPalette({ page:"palette/index.html", width:360, height:520 })`.
- 트리거 등록:
  - `ctx.radialMenu.addItem({ itemId:"palette", label:"클립보드", actionId:"togglePalette" })`
  - `ctx.actions.registerAction({ id:"togglePalette", callback: () => handle.toggle() })`
  - (선택) `ctx.shortcuts.registerShortcut({ actionKey:"togglePalette", … })`
- 데이터 동기화:
  - `ctx.host.clipboardHistory.onChanged(rebuildAndPush)`
  - `handle.onMessage(async (msg) => { … })` — paste/delete/pin/clearAll/ready 처리
- `rebuildAndPush()`: `list()` + `storage.getJson("pins")` 병합 → 이미지 blobUrl 매핑 → `handle.postMessage({type:"items", items})`.
- **blobUrl 캐시:** 같은 히스토리 id를 매번 putBlob 하지 않도록 `Map<historyId, blobId>` 유지, 항목 사라지면 `deleteBlob`.
- cleanup: `handle.close()` + `onChanged` dispose (ctx.handles가 registration은 자동 dispose).
- **자기완결 ESM:** 외부 npm import 금지. 순수 JS만.

### 3.3 `palette/index.html` (renderer)
- 인라인 `<style>` + `<script>`. 외부 리소스 로드 없음(CSP: self + `dap-blob://`만).
- 로드되면 `window.dapPalette.postMessage({type:"ready"})`.
- `onMessage`로 `{type:"items"}` 받아 카드 리스트 렌더:
  - 상단 검색/필터 input, "전체 지우기" 버튼.
  - 카드: 텍스트는 미리보기 텍스트, 이미지는 `<img src=imageUrl>`. 핀 아이콘, 삭제(x).
  - 클릭 → `{type:"paste", id}`. 핀 토글 → `{type:"pin"/"unpin", id}`.
- **드래그앤드랍(UX 우선순위):**
  - MVP: 카드 `draggable`, `dragstart`에서 `dataTransfer.setData("text/plain", text)` — **팔레트 내부 out-of-app 텍스트 드래그**는 OS/대상 앱에 따라 제한적. 확실한 경로는 **클릭=paste**.
  - 파일/이미지의 진짜 외부 드롭은 호스트 `dragdrop.export`(Phase 5, `webContents.startDrag`) 필요 → **후속**. 그전까지 드래그는 팔레트 내 재정렬(순서 저장)로 활용.

---

## 4. 마일스톤

| # | 목표 | 완료 기준 |
|---|---|---|
| **M0** | 스캐폴딩 + 설치 | plugin.yaml+빈 plugin.mjs+빈 팔레트가 DAP에 설치·활성화되고 래디얼에서 빈 창이 뜬다 |
| **M1** | 텍스트 코어 루프 | 복사→카드 표시→클릭→다른 앱에 paste + 클립보드 원복 확인 |
| **M2** | 이미지 표시 | 이미지 복사→썸네일 카드, blobUrl 캐시/정리 동작 |
| **M3** | 관리 UX | 핀 고정(storage), 검색/필터, 삭제, 전체지우기, 순서 저장 |
| **M4** | 드래그앤드랍 다듬기 | 카드 드래그 재정렬 + dragstart 텍스트 export, 애니메이션/드롭 프리뷰 |
| **M5(후속)** | 진짜 외부 드롭/이미지 paste | 호스트 `dragdrop.export`·이미지 paste 구현되면 연동 |

---

## 5. 개발/테스트 방법

- **설치 경로:** `~/.deskpet/plugins/com.example.super_clipboard/`에 이 레포 내용을 배치(심링크 또는 복사) 후 DAP 설정에서 활성화. `clipboard.history`는 설정에서 **명시 옵트인**해야 캡처 시작.
- **반복:** plugin.mjs는 (de)activate로 리로드. 팔레트 HTML은 창 재오픈으로 갱신.
- **도그푸드 체크리스트(win32):** 복사→팔레트→클릭 paste→원본 클립보드 원복 / 핀 유지(재시작) / 이미지 썸네일 / OTP·비밀번호가 히스토리에 안 잡히는지(호스트 게이트).
- **주의:** 이미지 paste·진짜 외부 드롭은 호스트 후속 기능 의존 — MVP에서 "안 됨"이 아니라 "후속"으로 표시.

---

## 6. 열린 질문 / 확인 필요

1. **`execution_modes` 값** — 외부 설치형 표준이 `user`가 맞는지 (호스트 플랜 §16 "Needs confirmation").
2. **설치 UI 권한 동의** — 호스트 쪽 동의 다이얼로그가 이 브랜치에 이미 green이라 했으니, 설치 시 권한 배지가 뜨는지 실측.
3. **팔레트 트리거 UX** — 래디얼 메뉴 / 전역 단축키 / 트레이 중 무엇을 기본으로? (M0에서 결정)
4. **이 레포를 어떻게 배포?** — 호스트 catalog는 현재 비어있음(`plugin_catalog.json: {plugins:[]}`). git clone 설치 모델이므로 공개 repo가 필요할 수 있음.
