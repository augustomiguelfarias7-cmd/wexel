package main

import (
	"bytes"
	"fmt"
	"syscall/js"

	"github.com/traefik/yaegi/interp"
	"github.com/traefik/yaegi/stdlib"
)

func main() {
	global := js.Global()
	api := map[string]any{
		"run":     js.FuncOf(runGo),
		"version": "Yaegi v0.16.1",
	}
	global.Set("wexelYaegi", api)
	select {}
}

func runGo(_ js.Value, args []js.Value) (result any) {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return map[string]any{"success": false, "stdout": "", "stderr": "", "error": "run expects one Go source string"}
	}
	var stdout, stderr bytes.Buffer
	defer func() {
		if recovered := recover(); recovered != nil {
			result = map[string]any{
				"success": false,
				"stdout":  stdout.String(),
				"stderr":  stderr.String(),
				"error":   fmt.Sprint(recovered),
			}
		}
	}()

	interpreter := interp.New(interp.Options{Stdout: &stdout, Stderr: &stderr})
	if err := interpreter.Use(stdlib.Symbols); err != nil {
		return map[string]any{"success": false, "stdout": stdout.String(), "stderr": stderr.String(), "error": err.Error()}
	}
	if _, err := interpreter.Eval(args[0].String()); err != nil {
		return map[string]any{"success": false, "stdout": stdout.String(), "stderr": stderr.String(), "error": err.Error()}
	}
	return map[string]any{"success": true, "stdout": stdout.String(), "stderr": stderr.String(), "error": ""}
}
