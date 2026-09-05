package main

// Build-time identity, injected by scripts/build-cli.mjs via -ldflags
// from the single-source policy in shared/cliDist.mts. The defaults
// cover `go run ./cli` straight from the checkout, which -- like the
// dev binary -- must only ever touch dev state.
var (
	version     = "dev"
	flavor      = "dev" // "prod" | "dev"; mirrors app.isPackaged
	dataDirName = ".smd"
	// The data dir's name before 2.0 (shared/cliDist.mts
	// legacyDataDirName explains the adoption rule).
	legacyDataDirName = "shigomori-dev"
	// The flavor's directory under $XDG_CONFIG_HOME, holding the
	// pointer file (state.go). Frozen, like the pointer's names: the
	// current one and the one from before 2.0.
	configDirName            = "shigomori-dev"
	dataDirPointerName       = "data-dir"
	legacyDataDirPointerName = "root"
	binaryName               = "smd"
	aliasName                = "shigomori-dev"
	appBundleID              = "com.sylophi.shigomori"
	// GitHub repo behind the update feed (shared/cliDist.mts
	// UPDATE_FEED_REPO). Only `sm update` reads it, and the dev CLI
	// refuses that command, but the default keeps `go run ./cli`
	// pointing somewhere real.
	updateFeedRepo = "sylophi/shigoto-no-mori"
)

// CFBundleExecutable of the installed app: stable across bundle moves
// and renames, which makes it the check that a published pid really is
// the app and not a recycled pid (cmd_update.go appProcessAlive).
const appExecutableName = "Shigoto no Mori"
