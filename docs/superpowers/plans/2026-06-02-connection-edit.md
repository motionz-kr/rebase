# 연결 편집 (Connection Edit) Implementation Plan

**Goal:** 기존 연결 프로필을 UI에서 수정한다(생성/삭제만 있던 빈틈 해소).

**Architecture:** 엔진의 `ConnectionService.UpdateProfile` + SQLite `Update`는 이미 존재. 빠진 PUT `/profiles` HTTP 핸들러+라우트, IPC `update-profile`, 렌더러 편집 모드만 추가한다. 순수 로직 없음 → 빌드 + 라이브 검증.

**Tech Stack:** Go(engine), Electron IPC, React/TS.

> 브랜치 `feat/connection-edit`. Go: `/Users/smlee/sdk/go/bin/go`. node/pnpm nvm. 비밀번호는 **수정 시 비우면 기존 유지**(서비스가 password!='' 일 때만 갱신).

---

## Task CE-1: 엔진 PUT 핸들러 + 라우트 + IPC + 타입

**Files:** `engine/internal/transport/http/profile.go`, `engine/cmd/app-engine/main.go`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts`

1. `profile.go` — add `UpdateProfile()` handler (mirror `CreateProfile`): decode `ProfileRequest{profile,password}`, require `req.Profile.ID != ""` (400 if empty), call `h.service.UpdateProfile(r.Context(), &req.Profile, req.Password)` (500 on error), return 200 + `req.Profile`.
2. `main.go` — in the `/profiles` method switch, add `case http.MethodPut: profileHandler.UpdateProfile().ServeHTTP(w, r)`.
3. `main/index.ts` — `ipcMain.handle('update-profile', async (e, profile, password) => { try { const data = await requestEngine({ method:'PUT', path:'/profiles', body:{ profile, password } }); return {success:true, data}; } catch(err){ return {success:false, error:err.message}; } })`.
4. `preload/index.ts` — `updateProfile: (profile: any, password?: string) => ipcRenderer.invoke('update-profile', profile, password)` (after createProfile).
5. `global.d.ts` — `updateProfile: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<ConnectionProfile>>;` (after createProfile).

Verify: `cd engine && go build ./...`; renderer+desktop `tsc --noEmit`.

## Task CE-2: 렌더러 편집 모드 UI

**Files:** `apps/renderer/src/App.tsx`

- `editingId` 상태(`useState<string | null>(null)`).
- `startEdit(p, e)`: stopPropagation; 폼 필드를 p로 채움(driver/name/host/port/database/username/tlsMode); `setFormPassword('')`; `setEditingId(p.id!)`; `setShowCreateForm(true)`; `setConnectionError(null)`.
- 제출 핸들러 분기: `editingId`면 `updateProfile({...profile, id: editingId}, formPassword)`, 아니면 `createProfile`. 성공 시 `setShowCreateForm(false); setEditingId(null); resetForm(); loadProfiles();`.
- `resetForm`/"New" 토글 시 `setEditingId(null)`.
- conn-row-actions에 **편집 버튼**(Pencil) 추가 → `startEdit(p, e)`.
- 폼 제목/저장 버튼 텍스트가 editingId면 "수정"; 비밀번호 입력 placeholder "비우면 기존 유지".

Verify: `tsc --noEmit` + `npm run build`.

## Task CE-3: 라이브 검증

- 엔진 재빌드(`pnpm build:engine`) + 앱 재시작(새 PUT 라우트 로드).
- CDP: 임시 프로필 생성 → 편집 버튼 → 이름/포트 변경, 비밀번호 비움 → 저장 → 목록 반영 확인 → 재연결 확인 → 임시 프로필 삭제.
- 빌드/tsc 클린.
