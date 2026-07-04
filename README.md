# Super Clipboard

복사한 **텍스트 · 이미지 · 파일**을 팔레트(보드)에 모아두고, 필요할 때 꺼내 쓰는 DAP(mydeskpet) 외부 플러그인.

## 기능

- 클립보드 히스토리를 팔레트 카드로 수집 (텍스트 / 이미지 / 파일)
- **텍스트** — 카드 클릭 → 현재 커서가 있는 입력칸에 붙여넣기 (팔레트는 열린 채 유지)
- **이미지** — 썸네일을 드래그 → 채팅 / 에디터 / 탐색기에 파일로 드롭
- **파일** — 카드를 드래그 → 다른 앱으로 파일 내보내기
- 고정(핀), 검색/필터, 삭제, 전체 지우기, 드래그로 순서 재배치
- 전역 단축키 `Ctrl+Shift+V` 또는 펫 래디얼 메뉴 "클립보드"로 열기
- 팔레트는 항상 위 + 타이틀바 핸들로 다른 모니터로 이동 가능

## 구조

```
plugin.yaml                      # manifest (권한 선언)
dap_super_clipboard/plugin.mjs   # main-side activate(ctx) — 특권 작업 전담
palette/index.html               # 팔레트 UI (sandbox, window.dapPalette 만 사용)
```

특권 작업(히스토리 읽기 · blob 저장 · paste · 드래그)은 전부 `plugin.mjs`(main)가 하고,
팔레트 페이지와는 메시지 프로토콜로만 통신한다. 이미지는 `dap-blob://` URL로 표시.

## 설치 (개발)

`<userData>/plugins/com.example.super_clipboard/` 에 이 폴더 내용을 배치한 뒤 DAP에서 활성화.
클립보드 히스토리 캡처는 기본 OFF이므로 설정(`settings.json`의 `clipboardHistory: true`)에서 옵트인해야 한다.

## 권한

`clipboard.history` · `storage.private` · `window.palette` · `input.synthesize` · `dragdrop.export`

## 제약

- 텍스트를 외부 앱 입력칸에 **드래그**로 넣는 것은 Electron 제약상 불가 → 텍스트는 클릭=붙여넣기.
- 이미지/파일은 네이티브 드래그로 외부 앱에 드롭 가능.

자세한 설계는 [PLAN.md](PLAN.md) 참조.
