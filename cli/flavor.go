package main

// Build-time identity, injected by scripts/build-cli.mjs via -ldflags
// from the single-source policy in shared/cliDist.mts. The defaults
// cover `go run ./cli` straight from the checkout, which -- like the
// dev binary -- must only ever touch dev state.
var (
	version     = "dev"
	flavor      = "dev" // "prod" | "dev"; mirrors app.isPackaged
	rootDirName = "shigomori-dev"
	binaryName  = "smd"
	appBundleID = "com.sylophi.shigomori"
)
