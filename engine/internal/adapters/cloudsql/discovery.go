package cloudsql

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// finder locates cloud-sql-proxy and gcloud; the function fields are injectable for tests.
type finder struct {
	lookPath     func(string) (string, error)
	homeDir      func() (string, error)
	stat         func(string) (os.FileInfo, error)
	evalSymlinks func(string) (string, error)
	goos         string
}

var defaultFinder = finder{lookPath: exec.LookPath, homeDir: os.UserHomeDir, stat: os.Stat, evalSymlinks: filepath.EvalSymlinks, goos: runtime.GOOS}

func findProxy(explicit string) (string, error) { return defaultFinder.findProxy(explicit) }
func findGcloudDir() string                     { return defaultFinder.findGcloudDir() }

func (f finder) isExecutable(path string) bool {
	info, err := f.stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return f.goos == "windows" || info.Mode().Perm()&0o111 != 0
}

func (f finder) fileName(name string) string {
	if f.goos == "windows" {
		return name + ".exe"
	}
	return name
}

// fixedDirs are searched because desktop launches often have a minimal PATH. POSIX-only.
func (f finder) fixedDirs() []string {
	if f.goos == "windows" {
		return nil
	}
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if home, err := f.homeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"), filepath.Join(home, "google-cloud-sdk", "bin"))
	}
	return append(dirs, "/opt/homebrew/share/google-cloud-sdk/bin", "/usr/local/share/google-cloud-sdk/bin", "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin")
}

func (f finder) findGcloudDir() string {
	if path, err := f.lookPath("gcloud"); err == nil {
		if resolved, err := f.evalSymlinks(path); err == nil {
			path = resolved
		}
		return filepath.Dir(path)
	}
	for _, dir := range f.fixedDirs() {
		if f.isExecutable(filepath.Join(dir, f.fileName("gcloud"))) {
			return dir
		}
	}
	return ""
}

func (f finder) findProxy(explicit string) (string, error) {
	if explicit != "" {
		if !f.isExecutable(explicit) {
			return "", errors.New("Cloud SQL: 지정한 cloud-sql-proxy 경로를 실행할 수 없습니다")
		}
		return explicit, nil
	}
	if path, err := f.lookPath("cloud-sql-proxy"); err == nil {
		return path, nil
	}
	name := f.fileName("cloud-sql-proxy")
	dirs := f.fixedDirs()
	if dir := f.findGcloudDir(); dir != "" {
		dirs = append([]string{dir}, dirs...)
	}
	for _, dir := range dirs {
		if path := filepath.Join(dir, name); f.isExecutable(path) {
			return path, nil
		}
	}
	return "", errors.New("Cloud SQL: cloud-sql-proxy를 찾을 수 없습니다. gcloud components install cloud-sql-proxy 또는 brew install cloud-sql-proxy 로 설치하거나 실행 파일 경로를 지정하세요")
}
