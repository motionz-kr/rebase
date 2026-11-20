package cloudsql

import (
	"reflect"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func cloudProfile(cfg domain.GCPCloudSQLConfig) domain.ConnectionProfile {
	return domain.ConnectionProfile{ID: "cvi", Name: "cvi", Driver: "mysql", Database: "app", ConnectionMode: "gcp_cloudsql", GCPCloudSQL: &cfg}
}

const instance = "my-project:asia-northeast3:cvi-db"

func TestProxyArgs(t *testing.T) {
	tests := []struct {
		name string
		cfg  domain.GCPCloudSQLConfig
		want []string
	}{
		{"default gcloud", domain.GCPCloudSQLConfig{InstanceConnectionName: instance}, []string{"--gcloud-auth", "--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
		{"explicit gcloud", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "gcloud"}, []string{"--gcloud-auth", "--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
		{"adc", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "adc"}, []string{"--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
		{"credentials file", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "credentials_file", CredentialsFile: "/keys/sa.json"}, []string{"--credentials-file", "/keys/sa.json", "--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
		{"private ip", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "adc", PrivateIP: true}, []string{"--private-ip", "--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
		{"gcloud private ip ignores credentials file", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, PrivateIP: true, CredentialsFile: "/keys/sa.json"}, []string{"--gcloud-auth", "--private-ip", "--address", "127.0.0.1", "--port", "15432", "--run-connection-test", instance}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, err := proxyArgs(cloudProfile(tt.cfg), 15432)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(args, tt.want) {
				t.Fatalf("args: %v\nwant: %v", args, tt.want)
			}
		})
	}
}

func TestProxyArgsErrors(t *testing.T) {
	good := domain.GCPCloudSQLConfig{InstanceConnectionName: instance}
	notCloud := cloudProfile(good)
	notCloud.ConnectionMode = "ssm"
	badInstance := cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: "badname"})
	tests := []struct {
		name    string
		profile domain.ConnectionProfile
		port    int
		want    string
	}{
		{"wrong mode", notCloud, 15432, "Cloud SQL connection mode is required"},
		{"invalid route", badInstance, 15432, "Cloud SQL requires an instance connection name"},
		{"port zero", cloudProfile(good), 0, "invalid local proxy port"},
		{"port too large", cloudProfile(good), 65536, "invalid local proxy port"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args, err := proxyArgs(tt.profile, tt.port)
			if err == nil || !strings.Contains(err.Error(), tt.want) || args != nil {
				t.Fatalf("args=%v err=%v", args, err)
			}
		})
	}
}

func TestStartupError(t *testing.T) {
	const (
		invalidProject = `proxy server error: failed to get instance: refresh error: failed to get instance metadata (connection name = "x:y:z"): googleapi: Error 400: Project specified in the request is invalid., errorInvalidProject`
		badKeyFile     = "Error starting proxy: error initializing dialer: config error: open /nonexistent/key.json: no such file or directory\nThe proxy has encountered a terminal error: unable to start: error initializing dialer"
		msgFlag        = "Cloud SQL: cloud-sql-proxy v2 최신 버전이 필요합니다. gcloud components update 또는 재설치 후 다시 시도하세요"
		msgLogin       = "Cloud SQL: gcloud 로그인이 만료되었습니다. 터미널에서 gcloud auth login 을 실행하세요"
		msgADC         = "Cloud SQL: Application Default Credentials가 없습니다. gcloud auth application-default login 을 실행하거나 인증 방식을 바꾸세요"
		msgKey         = "Cloud SQL: 서비스 계정 키 파일을 읽지 못했습니다. 경로와 권한을 확인하세요"
		msgIAM         = "Cloud SQL: IAM 권한이 부족합니다. 대상 프로젝트에 roles/cloudsql.client 권한이 필요합니다"
		msgNotFound    = "Cloud SQL: 인스턴스를 찾을 수 없습니다. 인스턴스 연결 이름(project:region:instance)을 확인하세요"
		msgPrivate     = "Cloud SQL: 인스턴스에 Private IP가 없거나 이 네트워크에서 접근할 수 없습니다. Private IP 설정을 확인하세요"
		msgDefault     = "Cloud SQL Proxy를 시작하지 못했습니다. gcloud 인증, 인스턴스 이름과 네트워크 설정을 확인하세요"
	)
	tests := []struct {
		name   string
		output string
		want   string
	}{
		{"unknown flag", "Error: unknown flag: --run-connection-test", msgFlag},
		{"reauth", "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed", msgLogin},
		{"invalid_grant", "oauth2: cannot fetch token: invalid_grant", msgLogin},
		{"invalid_rapt", "invalid_rapt", msgLogin},
		{"token expired", "Token has been expired or revoked", msgLogin},
		{"gcloud auth login", "please run gcloud auth login", msgLogin},
		{"adc", "credentials: could not find default credentials. See https://cloud.google.com/docs/authentication", msgADC},
		{"real bad key file", badKeyFile, msgKey},
		{"credentials file config error", "credentials file: config error: bad json", msgKey},
		{"credentials-file no such file", "--credentials-file /x.json: no such file or directory", msgKey},
		{"iam 403", "googleapis: Error 403: boom", msgIAM},
		{"not authorized", "Not authorized to access resource", msgIAM},
		{"permission", "permission denied for project", msgIAM},
		{"cloudsql.instances.get", "missing cloudsql.instances.get", msgIAM},
		{"real invalid project", invalidProject, msgNotFound},
		{"404", "googleapi: Error 404: whatever", msgNotFound},
		{"does not exist", "instance does not exist", msgNotFound},
		{"not found", "the instance was Not Found", msgNotFound},
		{"invalid project", "invalid project id", msgNotFound},
		{"private ip", "instance has no private ip address", msgPrivate},
		{"private type", `instance does not have IP of type "PRIVATE"`, msgPrivate},
		{"default", "Connection test failed: dial tcp: i/o timeout", msgDefault},
		{"empty", "", msgDefault},
		// first match wins: flag beats everything else
		{"flag before iam", "unknown flag permission error 403", msgFlag},
		{"login before iam", "reauth permission", msgLogin},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := startupError(tt.output)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("got %v\nwant %s", err, tt.want)
			}
		})
	}
}

func TestStartupErrorNeverLeaksRawOutput(t *testing.T) {
	const secret = "secret-e2e-token"
	for _, line := range []string{
		"unknown flag secret-e2e-token", "reauth secret-e2e-token", "could not find default credentials secret-e2e-token",
		"credentials file no such file /secret-e2e-token.json", "error 403 secret-e2e-token", "error 404 secret-e2e-token",
		"private ip secret-e2e-token", "random secret-e2e-token",
	} {
		if err := startupError(line); err == nil || strings.Contains(err.Error(), secret) {
			t.Fatalf("%q leaked: %v", line, err)
		}
	}
}
