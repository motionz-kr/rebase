// Package cloudsql owns local cloud-sql-proxy process lifecycles.
package cloudsql

import (
	"errors"
	"strconv"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func proxyArgs(p domain.ConnectionProfile, localPort int) ([]string, error) {
	if p.ConnectionMode != "gcp_cloudsql" {
		return nil, errors.New("Cloud SQL connection mode is required")
	}
	if err := p.ValidateConnectionRoute(); err != nil {
		return nil, err
	}
	if localPort < 1 || localPort > 65535 {
		return nil, errors.New("invalid local proxy port")
	}
	cfg := p.GCPCloudSQL
	var args []string
	switch cfg.AuthMode {
	case "", "gcloud":
		args = append(args, "--gcloud-auth")
	case "credentials_file":
		args = append(args, "--credentials-file", cfg.CredentialsFile)
	}
	if cfg.PrivateIP {
		args = append(args, "--private-ip")
	}
	args = append(args, "--address", "127.0.0.1", "--port", strconv.Itoa(localPort), "--run-connection-test", cfg.InstanceConnectionName)
	return args, nil
}

func containsAny(value string, patterns ...string) bool {
	for _, pattern := range patterns {
		if strings.Contains(value, pattern) {
			return true
		}
	}
	return false
}

// Return curated diagnostics: raw proxy output may contain tokens or local paths.
func startupError(output string) error {
	value := strings.ToLower(output)
	switch {
	case strings.Contains(value, "unknown flag"):
		return errors.New("Cloud SQL: cloud-sql-proxy v2 최신 버전이 필요합니다. gcloud components update 또는 재설치 후 다시 시도하세요")
	case containsAny(value, "reauth", "invalid_grant", "invalid_rapt", "token has been expired", "gcloud auth login"):
		return errors.New("Cloud SQL: gcloud 로그인이 만료되었습니다. 터미널에서 gcloud auth login 을 실행하세요")
	case strings.Contains(value, "could not find default credentials"):
		return errors.New("Cloud SQL: Application Default Credentials가 없습니다. gcloud auth application-default login 을 실행하거나 인증 방식을 바꾸세요")
	case containsAny(value, "credentials file", "credentials-file") && containsAny(value, "no such file", "config error"):
		return errors.New("Cloud SQL: 서비스 계정 키 파일을 읽지 못했습니다. 경로와 권한을 확인하세요")
	case containsAny(value, "error 403", "notauthorized", "not authorized", "permission", "cloudsql.instances.get"):
		return errors.New("Cloud SQL: IAM 권한이 부족합니다. 대상 프로젝트에 roles/cloudsql.client 권한이 필요합니다")
	case containsAny(value, "error 404", "does not exist", "not found", "errorinvalidproject", "invalid project", "instance does not exist"):
		return errors.New("Cloud SQL: 인스턴스를 찾을 수 없습니다. 인스턴스 연결 이름(project:region:instance)을 확인하세요")
	case containsAny(value, "private ip", "no private ip", `does not have ip of type "private"`):
		return errors.New("Cloud SQL: 인스턴스에 Private IP가 없거나 이 네트워크에서 접근할 수 없습니다. Private IP 설정을 확인하세요")
	default:
		return errors.New("Cloud SQL Proxy를 시작하지 못했습니다. gcloud 인증, 인스턴스 이름과 네트워크 설정을 확인하세요")
	}
}
