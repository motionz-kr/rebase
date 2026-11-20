package cloudsql

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeInfo struct {
	mode fs.FileMode
}

func (f fakeInfo) Name() string       { return "x" }
func (f fakeInfo) Size() int64        { return 1 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return nil }

// Fixtures are written with slashes and converted to the host separator, the
// same form filepath.Join produces in production, so keys match on every OS.
func nativeMap[V any](in map[string]V) map[string]V {
	out := make(map[string]V, len(in))
	for k, v := range in {
		out[filepath.FromSlash(k)] = v
	}
	return out
}

func nativeValues(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[filepath.FromSlash(k)] = filepath.FromSlash(v)
	}
	return out
}

// fakeFinder builds a finder over a virtual file system: path -> mode.
func fakeFinder(goos string, pathBinaries map[string]string, files map[string]fs.FileMode, links map[string]string) finder {
	pathBinaries, files, links = nativeValuesKeepKeys(pathBinaries), nativeMap(files), nativeValues(links)
	return finder{
		goos: goos,
		lookPath: func(name string) (string, error) {
			if p, ok := pathBinaries[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		homeDir: func() (string, error) { return filepath.FromSlash("/home/u"), nil },
		stat: func(p string) (os.FileInfo, error) {
			if m, ok := files[p]; ok {
				return fakeInfo{mode: m}, nil
			}
			return nil, os.ErrNotExist
		},
		evalSymlinks: func(p string) (string, error) {
			if t, ok := links[p]; ok {
				return t, nil
			}
			return p, nil
		},
	}
}

func nativeValuesKeepKeys(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = filepath.FromSlash(v)
	}
	return out
}

const (
	exe      = fs.FileMode(0o755)
	nonExe   = fs.FileMode(0o644)
	notFound = "Cloud SQL: cloud-sql-proxy를 찾을 수 없습니다. gcloud components install cloud-sql-proxy 또는 brew install cloud-sql-proxy 로 설치하거나 실행 파일 경로를 지정하세요"
	badPath  = "Cloud SQL: 지정한 cloud-sql-proxy 경로를 실행할 수 없습니다"
)

func TestFindProxy(t *testing.T) {
	tests := []struct {
		name     string
		goos     string
		explicit string
		path     map[string]string
		files    map[string]fs.FileMode
		links    map[string]string
		want     string
		wantErr  string
	}{
		{name: "explicit executable", goos: "linux", explicit: "/opt/p/proxy", files: map[string]fs.FileMode{"/opt/p/proxy": exe}, want: "/opt/p/proxy"},
		{name: "explicit missing no fallback", goos: "linux", explicit: "/opt/p/proxy", path: map[string]string{"cloud-sql-proxy": "/usr/bin/cloud-sql-proxy"}, wantErr: badPath},
		{name: "explicit not executable", goos: "linux", explicit: "/opt/p/proxy", files: map[string]fs.FileMode{"/opt/p/proxy": nonExe}, wantErr: badPath},
		{name: "explicit directory", goos: "linux", explicit: "/opt/p", files: map[string]fs.FileMode{"/opt/p": fs.ModeDir | exe}, wantErr: badPath},
		{name: "explicit windows regular file", goos: "windows", explicit: `C:\p\proxy.exe`, files: map[string]fs.FileMode{`C:\p\proxy.exe`: nonExe}, want: `C:\p\proxy.exe`},
		{name: "explicit windows directory", goos: "windows", explicit: `C:\p`, files: map[string]fs.FileMode{`C:\p`: fs.ModeDir}, wantErr: badPath},
		{name: "on PATH", goos: "linux", path: map[string]string{"cloud-sql-proxy": "/usr/bin/cloud-sql-proxy"}, want: "/usr/bin/cloud-sql-proxy"},
		{
			name: "next to gcloud via symlink", goos: "darwin",
			path:  map[string]string{"gcloud": "/opt/homebrew/bin/gcloud"},
			links: map[string]string{"/opt/homebrew/bin/gcloud": "/sdk/google-cloud-sdk/bin/gcloud"},
			files: map[string]fs.FileMode{"/sdk/google-cloud-sdk/bin/cloud-sql-proxy": exe},
			want:  "/sdk/google-cloud-sdk/bin/cloud-sql-proxy",
		},
		{
			name: "off-PATH sdk does not override fixed dir order", goos: "darwin",
			files: map[string]fs.FileMode{"/opt/homebrew/bin/cloud-sql-proxy": exe, "/home/u/google-cloud-sdk/bin/cloud-sql-proxy": exe, "/home/u/google-cloud-sdk/bin/gcloud": exe},
			want:  "/opt/homebrew/bin/cloud-sql-proxy",
		},
		{name: "fixed dir homebrew", goos: "darwin", files: map[string]fs.FileMode{"/opt/homebrew/bin/cloud-sql-proxy": exe}, want: "/opt/homebrew/bin/cloud-sql-proxy"},
		{name: "fixed dir home local", goos: "linux", files: map[string]fs.FileMode{"/home/u/.local/bin/cloud-sql-proxy": exe}, want: "/home/u/.local/bin/cloud-sql-proxy"},
		{name: "fixed dir home sdk", goos: "linux", files: map[string]fs.FileMode{"/home/u/google-cloud-sdk/bin/cloud-sql-proxy": exe}, want: "/home/u/google-cloud-sdk/bin/cloud-sql-proxy"},
		{name: "fixed dir caskroom", goos: "darwin", files: map[string]fs.FileMode{"/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/cloud-sql-proxy": exe}, want: "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin/cloud-sql-proxy"},
		{name: "non executable candidate skipped", goos: "linux", files: map[string]fs.FileMode{"/usr/local/bin/cloud-sql-proxy": nonExe}, wantErr: notFound},
		{name: "windows skips fixed dirs", goos: "windows", files: map[string]fs.FileMode{"/usr/local/bin/cloud-sql-proxy.exe": exe}, wantErr: notFound},
		{
			name: "windows next to gcloud uses exe suffix", goos: "windows",
			path:  map[string]string{"gcloud": "C:/sdk/bin/gcloud.cmd"},
			files: map[string]fs.FileMode{filepath.Join("C:/sdk/bin", "cloud-sql-proxy.exe"): nonExe},
			want:  filepath.Join("C:/sdk/bin", "cloud-sql-proxy.exe"),
		},
		{name: "not found", goos: "linux", wantErr: notFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeFinder(tt.goos, tt.path, tt.files, tt.links)
			got, err := f.findProxy(filepath.FromSlash(tt.explicit))
			if tt.wantErr != "" {
				if err == nil || err.Error() != tt.wantErr || got != "" {
					t.Fatalf("got %q, %v", got, err)
				}
				return
			}
			if err != nil || got != filepath.FromSlash(tt.want) {
				t.Fatalf("got %q, %v want %q", got, err, tt.want)
			}
		})
	}
}

func TestFindGcloudDir(t *testing.T) {
	tests := []struct {
		name  string
		goos  string
		path  map[string]string
		files map[string]fs.FileMode
		links map[string]string
		want  string
	}{
		{name: "on PATH resolves symlink", goos: "darwin", path: map[string]string{"gcloud": "/opt/homebrew/bin/gcloud"}, links: map[string]string{"/opt/homebrew/bin/gcloud": "/sdk/google-cloud-sdk/bin/gcloud"}, want: "/sdk/google-cloud-sdk/bin"},
		{name: "on PATH plain", goos: "linux", path: map[string]string{"gcloud": "/usr/bin/gcloud"}, want: "/usr/bin"},
		{name: "fixed dir", goos: "darwin", files: map[string]fs.FileMode{"/opt/homebrew/share/google-cloud-sdk/bin/gcloud": exe}, want: "/opt/homebrew/share/google-cloud-sdk/bin"},
		{name: "windows exe suffix not found in fixed dirs", goos: "windows", files: map[string]fs.FileMode{"/usr/local/bin/gcloud.exe": exe}, want: ""},
		{name: "none", goos: "linux", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeFinder(tt.goos, tt.path, tt.files, tt.links)
			if got := f.findGcloudDir(); got != filepath.FromSlash(tt.want) {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestSearchDirsOrder(t *testing.T) {
	f := fakeFinder("linux", nil, nil, nil)
	want := []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/u/.local/bin", "/home/u/google-cloud-sdk/bin", "/opt/homebrew/share/google-cloud-sdk/bin", "/usr/local/share/google-cloud-sdk/bin", "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin"}
	got := f.fixedDirs()
	for i := range got {
		got[i] = filepath.ToSlash(got[i])
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	if f2 := fakeFinder("windows", nil, nil, nil); len(f2.fixedDirs()) != 0 {
		t.Fatal(strings.Join(f2.fixedDirs(), ","))
	}
}
