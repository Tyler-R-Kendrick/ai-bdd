// Package aibdd is the HTTP JSON mirror client every ai-bdd Go integration uses.
//
// It discovers `.ai-bdd/daemon.json` (or takes an explicit URL and token), POSTs
// to `/v1/<tool>` and turns the AiBddError payload into a typed error.
package aibdd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Error is an AiBddError payload returned by the daemon.
type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Connection is the daemon's URL plus its bearer token.
type Connection struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// Client talks to one daemon.
type Client struct {
	ProjectRoot string
	URL         string
	Token       string
	HTTP        *http.Client

	connection *Connection
}

// NewClient builds a client for a project root, honouring AI_BDD_DAEMON_URL and
// AI_BDD_DAEMON_TOKEN when they are set.
func NewClient(projectRoot string) *Client {
	if projectRoot == "" {
		projectRoot = os.Getenv("AI_BDD_PROJECT_ROOT")
	}
	if projectRoot == "" {
		projectRoot, _ = os.Getwd()
	}
	return &Client{
		ProjectRoot: projectRoot,
		URL:         os.Getenv("AI_BDD_DAEMON_URL"),
		Token:       os.Getenv("AI_BDD_DAEMON_TOKEN"),
		HTTP:        &http.Client{Timeout: 60 * time.Second},
	}
}

// Available reports whether a daemon can be reached without starting one.
func (c *Client) Available() bool {
	if c.URL != "" {
		return true
	}
	_, err := os.Stat(filepath.Join(c.ProjectRoot, ".ai-bdd", "daemon.json"))
	return err == nil
}

// Connect resolves the connection details, reading `.ai-bdd/daemon.json` when needed.
func (c *Client) Connect() (*Connection, error) {
	if c.connection != nil {
		return c.connection, nil
	}
	if c.URL != "" {
		c.connection = &Connection{URL: c.URL, Token: c.Token}
		return c.connection, nil
	}
	path := filepath.Join(c.ProjectRoot, ".ai-bdd", "daemon.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, &Error{
			Code:    "DAEMON_UNAUTHORIZED",
			Message: fmt.Sprintf("no daemon is running: %s does not exist (start one with ai-bdd serve --http)", path),
		}
	}
	var connection Connection
	if err := json.Unmarshal(raw, &connection); err != nil {
		return nil, &Error{Code: "INTERNAL", Message: "daemon.json is not readable: " + err.Error()}
	}
	c.connection = &connection
	return c.connection, nil
}

// SetConnection pins the connection, which tests use with an in-process daemon.
func (c *Client) SetConnection(url, token string) {
	c.connection = &Connection{URL: url, Token: token}
}

// Call invokes one tool and unmarshals its result into out.
func (c *Client) Call(tool string, body any, out any) error {
	connection, err := c.Connect()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, connection.URL+"/v1/"+tool, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	if connection.Token != "" {
		request.Header.Set("authorization", "Bearer "+connection.Token)
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode >= 400 {
		var envelope struct {
			Error *Error `json:"error"`
		}
		if json.Unmarshal(raw, &envelope) == nil && envelope.Error != nil {
			return envelope.Error
		}
		return &Error{Code: "INTERNAL", Message: fmt.Sprintf("HTTP %d", response.StatusCode)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
