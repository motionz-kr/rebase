package ssm

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func startSessionArgs(p domain.ConnectionProfile, localPort int) ([]string, error) {
	if p.ConnectionMode != "ssm" {
		return nil, errors.New("SSM connection mode is required")
	}
	if err := p.ValidateConnectionRoute(); err != nil {
		return nil, err
	}
	if localPort < 1 || localPort > 65535 {
		return nil, errors.New("invalid local tunnel port")
	}
	values := map[string][]string{"localPortNumber": {strconv.Itoa(localPort)}}
	if !p.SSMUsesDocumentDestination() {
		values["host"] = []string{p.Host}
		values["portNumber"] = []string{strconv.Itoa(p.Port)}
	}
	parameters, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	document := p.SSM.DocumentName
	if document == "" {
		document = "AWS-StartPortForwardingSessionToRemoteHost"
	}
	args := []string{"ssm", "start-session", "--target", p.SSM.InstanceID, "--document-name", document, "--region", p.SSM.Region, "--parameters", string(parameters)}
	if p.SSM.Profile != "" {
		args = append(args, "--profile", p.SSM.Profile)
	}
	return args, nil
}

// Return curated diagnostics: raw CLI output may contain AWS credential material.
func startupError(output string) error {
	value := strings.ToLower(output)
	switch {
	case strings.Contains(value, "sessionmanagerplugin"), strings.Contains(value, "session-manager-plugin"):
		return errors.New("AWS SSM: session-manager-plugin을 설치하고 PATH를 확인하세요")
	case strings.Contains(value, "accessdenied"), strings.Contains(value, "unauthorized"):
		return errors.New("AWS SSM: IAM 권한이 부족합니다. 대상 EC2와 포트 전달 문서의 StartSession 권한을 확인하세요")
	case strings.Contains(value, "expired"), strings.Contains(value, "sso"), strings.Contains(value, "invalidclienttoken"), strings.Contains(value, "unable to locate credentials"):
		return errors.New("AWS SSM: AWS 인증이 필요합니다. SSO 사용 시 aws sso login --profile <프로필>을 실행하세요")
	case strings.Contains(value, "targetnotconnected"):
		return errors.New("AWS SSM: EC2가 연결되어 있지 않습니다. region, instance ID 및 SSM Agent 상태를 확인하세요")
	case strings.Contains(value, "profile") && strings.Contains(value, "not be found"):
		return errors.New("AWS SSM: AWS profile을 찾을 수 없습니다. 로컬 AWS 설정을 확인하세요")
	default:
		return errors.New("AWS SSM 터널을 시작하지 못했습니다. AWS 인증, EC2 상태와 네트워크 설정을 확인하세요")
	}
}
