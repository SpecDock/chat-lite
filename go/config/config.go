package config

import (
	"bytes"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type File struct {
	Server    Server    `yaml:"server"`
	Postgres  Postgres  `yaml:"postgres"`
	Redis     Redis     `yaml:"redis"`
	Kafka     Kafka     `yaml:"kafka"`
	LLM       LLM       `yaml:"llm"`
	Embedding Embedding `yaml:"embedding"`
	Tavily    Tavily    `yaml:"tavily"`
	SMTP      SMTP      `yaml:"smtp"`
	TextImage Vendor    `yaml:"text_image"`
	ImageEdit Vendor    `yaml:"image_edit"`
	OCR       Vendor    `yaml:"ocr"`
	Agent     Agent     `yaml:"agent"`
	RAG       RAG       `yaml:"rag"`
	MinIO     MinIO     `yaml:"minio"`
}

type Server struct {
	Port               string `yaml:"port"`
	Origin             string `yaml:"origin"`
	NodeEnv            string `yaml:"node_env"`
	Production         bool   `yaml:"-"`
	SchemaPath         string `yaml:"schema_path"`
	DataDir            string `yaml:"data_dir"`
	UploadDir          string `yaml:"upload_dir"`
	SessionCookieName  string `yaml:"session_cookie_name"`
	SessionTTLDays     int    `yaml:"session_ttl_days"`
	MaxUploadMB        int    `yaml:"max_upload_mb"`
	InviteCode         string `yaml:"invite_code"`
	AnswerHistoryLimit int    `yaml:"answer_history_limit"`
}

type Postgres struct {
	URL string `yaml:"url"`
}

type Redis struct {
	Addr     string `yaml:"addr"`
	Password string `yaml:"password"`
	DB       int    `yaml:"db"`
}

type Kafka struct {
	Brokers string `yaml:"brokers"`
	Topic   string `yaml:"topic"`
}

func (k Kafka) BrokerList() []string {
	parts := strings.Split(k.Brokers, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func (k Kafka) TopicName() string {
	topic := strings.TrimSpace(k.Topic)
	if topic == "" {
		return "chatlite-context"
	}
	return topic
}

type LLM struct {
	APIURL      string  `yaml:"api_url"`
	APIKey      string  `yaml:"api_key"`
	Model       string  `yaml:"model"`
	Temperature float64 `yaml:"temperature"`
	MaxAttempts int     `yaml:"max_attempts"`
}

type Embedding struct {
	APIURL     string `yaml:"api_url"`
	APIKey     string `yaml:"api_key"`
	Model      string `yaml:"model"`
	Dimensions int    `yaml:"dimensions"`
}

type Tavily struct {
	APIKey string `yaml:"api_key"`
}

type SMTP struct {
	Host          string `yaml:"host"`
	Port          int    `yaml:"port"`
	User          string `yaml:"user"`
	Password      string `yaml:"password"`
	From          string `yaml:"from"`
	TLSServerName string `yaml:"tls_server_name"`
}

type Vendor struct {
	APIURL string `yaml:"api_url"`
	APIKey string `yaml:"api_key"`
	Model  string `yaml:"model"`
}

type Agent struct {
	MaxToolCalls   int `yaml:"max_tool_calls"`
	RecursionLimit int `yaml:"recursion_limit"`
}

type MinIO struct {
	Endpoint  string `yaml:"endpoint"`
	AccessKey string `yaml:"access_key"`
	SecretKey string `yaml:"secret_key"`
	Bucket    string `yaml:"bucket"`
	UseSSL    string `yaml:"use_ssl"`
}

type RAG struct {
	WriteEnabled    bool    `yaml:"write_enabled"`
	ReadEnabled     bool    `yaml:"read_enabled"`
	ShadowEnabled   bool    `yaml:"shadow_enabled"`
	ContentMaxChars int     `yaml:"content_max_chars"`
	TopK            int     `yaml:"top_k"`
	MaxDistance     float64 `yaml:"max_distance"`
}

var current File

func Current() File { return current }

func Load() (File, error) {
	loadEnvFile("../.env")
	loadEnvFile(".env")
	body, err := os.ReadFile("config/config.yaml")
	if err != nil {
		return File{}, err
	}
	expanded := os.ExpandEnv(string(body))
	dec := yaml.NewDecoder(bytes.NewReader([]byte(expanded)))
	dec.KnownFields(true)
	var loaded File
	if err := dec.Decode(&loaded); err != nil {
		return File{}, err
	}
	loaded.Server.Production = loaded.Server.NodeEnv == "production"
	if loaded.Server.Port == "" {
		loaded.Server.Port = "3000"
	}
	if loaded.Server.SchemaPath == "" {
		loaded.Server.SchemaPath = "schema.sql"
	}
	if loaded.LLM.MaxAttempts < 1 {
		loaded.LLM.MaxAttempts = 1
	}
	if loaded.LLM.MaxAttempts > 3 {
		loaded.LLM.MaxAttempts = 3
	}
	if strings.TrimSpace(loaded.Kafka.Topic) == "" {
		loaded.Kafka.Topic = "chatlite-context"
	}
	current = loaded
	return loaded, nil
}

func loadEnvFile(path string) {
	body, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
}
