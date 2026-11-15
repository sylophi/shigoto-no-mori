package main

import "testing"

const dir = `C:\Users\me\AppData\Local\shigomori\bin`

func TestWithEntry(t *testing.T) {
	cases := []struct{ path, want string }{
		{"", dir},
		{`%USERPROFILE%\bin;C:\tools`, `%USERPROFILE%\bin;C:\tools;` + dir},
		{`C:\a;;C:\b`, `C:\a;;C:\b;` + dir},
		{`C:\a;C:\b;`, `C:\a;C:\b;` + dir + ";"},
		{`C:\a;` + dir + `;C:\b`, `C:\a;` + dir + `;C:\b`},
		{`C:\a;C:\USERS\ME\APPDATA\LOCAL\SHIGOMORI\BIN`, `C:\a;C:\USERS\ME\APPDATA\LOCAL\SHIGOMORI\BIN`},
	}
	for _, c := range cases {
		if got := withEntry(c.path, dir); got != c.want {
			t.Errorf("withEntry(%q) = %q, want %q", c.path, got, c.want)
		}
		if again := withEntry(withEntry(c.path, dir), dir); again != c.want {
			t.Errorf("withEntry twice on %q = %q, want %q", c.path, again, c.want)
		}
	}
}

func TestWithoutEntry(t *testing.T) {
	cases := []struct{ path, want string }{
		{"", ""},
		{dir, ""},
		{`C:\a;` + dir, `C:\a`},
		{`C:\a;` + dir + `;C:\b`, `C:\a;C:\b`},
		{`%USERPROFILE%\bin;;C:\B\..;` + dir + `;`, `%USERPROFILE%\bin;;C:\B\..;`},
		{`C:\a;c:\users\me\appdata\local\shigomori\BIN;C:\b`, `C:\a;C:\b`},
		{`C:\a;` + dir + `\sub;C:\b`, `C:\a;` + dir + `\sub;C:\b`},
	}
	for _, c := range cases {
		if got := withoutEntry(c.path, dir); got != c.want {
			t.Errorf("withoutEntry(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	for _, path := range []string{"", `C:\a`, `C:\a;`, `C:\a;;C:\b`, `%PATH%;C:\a;`} {
		if got := withoutEntry(withEntry(path, dir), dir); got != path {
			t.Errorf("adding and removing on %q gave %q", path, got)
		}
	}
}
