package domain

import (
	"errors"
	"regexp"
	"strings"
)

// SSMConfig contains references to AWS configuration, never credentials.
// Host/port identify the destination unless the SSM document owns it.
type SSMConfig struct {
	Profile         string `json:"profile"`
	Region          string `json:"region"`
	InstanceID      string `json:"instanceId"`
	DocumentName    string `json:"documentName,omitempty"`
	DestinationMode string `json:"destinationMode,omitempty"` // empty/remote-host, document
}

var ssmInstanceID = regexp.MustCompile(`^i-([0-9a-f]{8}|[0-9a-f]{17})$`)
var ssmRegion = regexp.MustCompile(`^[a-z]+(-[a-z0-9]+)+-[0-9]+$`)
var ssmDocumentName = regexp.MustCompile(`^[a-zA-Z0-9_\-.:/]{3,128}$`)

func (p ConnectionProfile) SSMUsesDocumentDestination() bool {
	return p.ConnectionMode == "ssm" && p.SSM != nil && p.SSM.DestinationMode == "document"
}

func (p ConnectionProfile) ValidateConnectionRoute() error {
	switch p.ConnectionMode {
	case "", "direct":
		return nil
	case "ssh":
		return p.validateSSHRoute()
	case "ssm":
	default:
		return errors.New("unsupported connection mode")
	}
	if p.Driver != "mysql" && p.Driver != "postgres" {
		return errors.New("AWS SSM connections support MySQL and PostgreSQL")
	}
	if p.SSM == nil || !ssmRegion.MatchString(p.SSM.Region) {
		return errors.New("AWS SSM requires a valid region")
	}
	if !ssmInstanceID.MatchString(p.SSM.InstanceID) {
		return errors.New("AWS SSM requires an EC2 instance ID (i-...)")
	}
	if strings.HasPrefix(p.SSM.Profile, "-") || strings.ContainsAny(p.SSM.Profile, "\r\n\x00") {
		return errors.New("invalid AWS profile name")
	}
	if p.SSM.DocumentName != "" && (!ssmDocumentName.MatchString(p.SSM.DocumentName) || strings.HasPrefix(p.SSM.DocumentName, "-")) {
		return errors.New("invalid AWS SSM document name")
	}
	switch p.SSM.DestinationMode {
	case "", "remote-host":
	case "document":
		if p.SSM.DocumentName == "" {
			return errors.New("AWS SSM document destination requires a document name")
		}
		return nil // Destination host and port are defined in the selected document.
	default:
		return errors.New("unsupported AWS SSM destination mode")
	}
	if strings.TrimSpace(p.Host) == "" || strings.ContainsAny(p.Host, " \t\r\n\x00") || p.Port <= 0 || p.Port > 65535 {
		return errors.New("AWS SSM requires a valid destination DB host and port")
	}
	return nil
}
