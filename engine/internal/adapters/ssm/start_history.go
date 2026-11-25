package ssm

import (
	"fmt"
	"time"
)

const (
	startWindow = time.Minute
	maxStarts   = 5
)

type startHistory struct {
	startedAt []time.Time
	failures  int
	retryAt   time.Time
	lastError error
}

// allowStart runs with the manager lock held. History outlives an individual
// tunnel, including the disposable tunnels used for connection tests.
func (m *Manager) allowStart(route string) (*startHistory, error) {
	now := m.now()
	cutoff := now.Add(-startWindow)
	for key, history := range m.starts {
		if (len(history.startedAt) == 0 || !history.startedAt[len(history.startedAt)-1].After(cutoff)) && !now.Before(history.retryAt) {
			delete(m.starts, key)
		}
	}
	history := m.starts[route]
	if history == nil {
		history = &startHistory{}
		m.starts[route] = history
	}
	for len(history.startedAt) > 0 && !history.startedAt[0].After(cutoff) {
		history.startedAt = history.startedAt[1:]
	}
	if len(history.startedAt) == maxStarts {
		wait := history.startedAt[0].Add(startWindow).Sub(now)
		return nil, fmt.Errorf("AWS SSM: 터널 시작 횟수 한도에 도달했습니다. %d초 후 다시 시도하세요", secondsToWait(wait))
	}
	if now.Before(history.retryAt) {
		return nil, fmt.Errorf("%w. %d초 후 다시 시도하세요", history.lastError, secondsToWait(history.retryAt.Sub(now)))
	}
	history.startedAt = append(history.startedAt, now)
	return history, nil
}

func (h *startHistory) recordResult(now time.Time, err error) {
	if err == nil {
		h.failures, h.retryAt, h.lastError = 0, time.Time{}, nil
		return
	}
	h.failures = min(h.failures+1, 5)
	delay := min(time.Second<<h.failures, 30*time.Second)
	h.retryAt, h.lastError = now.Add(delay), err
}

func secondsToWait(d time.Duration) int64 {
	return int64((d + time.Second - 1) / time.Second)
}
