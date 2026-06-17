package main

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"runtime"
)

func main() {
	webhook := os.Getenv("WEBHOOK_URL")
	body := fmt.Sprintf(
		`{"language":"Go","runtime":%q,"message":"Hello from Go running on Acurast!"}`,
		runtime.Version(),
	)

	resp, err := http.Post(webhook, "application/json", bytes.NewBufferString(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, "POST failed:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	fmt.Println("posted:", resp.Status)
}
