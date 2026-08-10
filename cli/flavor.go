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
	aliasName   = "shigomori-dev"
	appBundleID = "com.sylophi.shigomori"
)

// CFBundleExecutable of the installed app: stable across bundle moves
// and renames, which makes it the check that a published pid really is
// the app and not a recycled pid (cmd_update.go appProcessAlive).
const appExecutableName = "Shigoto no Mori"
