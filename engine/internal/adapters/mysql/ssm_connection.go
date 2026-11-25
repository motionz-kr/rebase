package mysql

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var errSSMHostBlocked = errors.New("MySQL 1129: SSM 경유 서버 IP가 DB에서 차단됐습니다. 관리자에게 host_cache 초기화를 요청한 뒤 다시 연결하세요")

type ssmDBRoute struct {
	region, instanceID, document, host string
	port                               int
}

func mysqlSSMRoute(p domain.ConnectionProfile) ssmDBRoute {
	route := ssmDBRoute{region: p.SSM.Region, instanceID: p.SSM.InstanceID}
	if p.SSMUsesDocumentDestination() {
		route.document = p.SSM.DocumentName
	} else {
		route.host, route.port = strings.ToLower(p.Host), p.Port
	}
	return route
}

type ssmHostBlocks struct {
	mu        sync.Mutex
	blockedAt map[ssmDBRoute]time.Time
}

func (b *ssmHostBlocks) blocked(route ssmDBRoute) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Since(b.blockedAt[route]) < time.Minute
}

func (b *ssmHostBlocks) record(route ssmDBRoute) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.blockedAt == nil {
		b.blockedAt = make(map[ssmDBRoute]time.Time)
	}
	now := time.Now()
	for key, at := range b.blockedAt {
		if now.Sub(at) >= time.Minute {
			delete(b.blockedAt, key)
		}
	}
	b.blockedAt[route] = now
}

type ssmMySQLConnector struct {
	driver.Connector
	blocks *ssmHostBlocks
	route  ssmDBRoute
}

func (c ssmMySQLConnector) Connect(ctx context.Context) (driver.Conn, error) {
	if c.blocks.blocked(c.route) {
		return nil, errSSMHostBlocked
	}
	conn, err := c.Connector.Connect(ctx)
	var dbErr *mysqlDriver.MySQLError
	if errors.As(err, &dbErr) && dbErr.Number == 1129 {
		c.blocks.record(c.route)
		return nil, errSSMHostBlocked
	}
	return conn, err
}
