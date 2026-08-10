package main

// The selection menu behind every picker: a small bubbletea loop with
// arrow keys or j/k, `/` to filter, enter to select, esc/ctrl-c to
// cancel, and scrolling on long lists. Output goes to stderr so
// command results (stdout) stay clean -- `cd "$(sm path)"` opens the
// menu and still cd's. Rows keep their own ANSI colors in every
// state: the selected row lays a background bar under them
// (selectedRow), and when color is off the rows carry no ANSI to
// begin with, so the bare arrow marks the selection. Non-tty stdio
// (and terminals bubbletea can't drive) gets the numbered prompt
// instead, which keeps `printf '2\n' | ...`-style scripting
// meaningful.

import (
	"bufio"
	"errors"
	"fmt"
	"image/color"
	"os"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// buildMenu aligns the optional header and the rows into one column
// grid, returning the header line and the row lines.
func buildMenu(header []string, cells [][]string) (string, []string) {
	if header == nil {
		return "", alignRows(cells)
	}
	lines := alignRows(append([][]string{header}, cells...))
	return lines[0], lines[1:]
}

// Background for the menu's selected row: a gray bar one step off the
// terminal background, quantized to the terminal's color depth ("" on
// colorless terminals -- the caller then relies on the arrow alone).
func menuBarBG() string {
	gray := color.RGBA{R: 58, G: 58, B: 58, A: 255}
	if !darkBackground() {
		gray = color.RGBA{R: 228, G: 228, B: 228, A: 255}
	}
	bar := colorProfile().FromColor(gray)
	if bar == nil {
		return ""
	}
	return bar.Sequence(true)
}

// The selected row keeps its cell colors and gains a background bar.
// Cells arrive pre-painted and every paint ends in a full reset, which
// would cut the bar mid-row -- so each reset is rewritten to one that
// re-applies the bar (the technique fzf uses).
func selectedRow(line string) string {
	bg := menuBarBG()
	if bg == "" {
		return line
	}
	restored := strings.ReplaceAll(line, ansiReset, "\x1b[0;"+bg+"m")
	return "\x1b[" + bg + "m" + restored + ansiReset
}

type menuModel struct {
	title  string
	header string
	rows   []string
	// Lowercased names that `/` filtering matches against. Names, not
	// whole rows: status cells repeat words like "clean" and "local"
	// on every row, which would make most queries match everything.
	filterText []string
	filtering  bool
	query      string
	visible    []int // indices into rows matching query
	cursor     int   // index into visible
	offset     int
	maxRows    int
	choice     int // index into rows, -1 until picked
	cancelled  bool
}

func (m *menuModel) applyFilter() {
	query := strings.ToLower(m.query)
	m.visible = m.visible[:0]
	for i, text := range m.filterText {
		if query == "" || strings.Contains(text, query) {
			m.visible = append(m.visible, i)
		}
	}
	if m.cursor >= len(m.visible) {
		m.cursor = max(0, len(m.visible)-1)
	}
}

func (m *menuModel) setHeight(height int) {
	// Title, help line, and up to two clip indicators surround the
	// rows (plus the filter line); keep a few rows even in tiny
	// terminals.
	m.maxRows = height - 5
	if m.maxRows < 3 {
		m.maxRows = 3
	}
}

func (m *menuModel) visibleRows() int {
	rows := m.maxRows
	if rows <= 0 || rows > len(m.visible) {
		rows = len(m.visible)
	}
	return rows
}

func (m *menuModel) clampScroll() {
	rows := m.visibleRows()
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+rows {
		m.offset = m.cursor - rows + 1
	}
	if m.offset > len(m.visible)-rows {
		m.offset = len(m.visible) - rows
	}
	if m.offset < 0 {
		m.offset = 0
	}
}

func (m *menuModel) move(delta int) {
	if n := len(m.visible); n > 0 {
		m.cursor = (m.cursor + delta + n) % n
	}
}

func (m *menuModel) Init() tea.Cmd { return nil }

func (m *menuModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.setHeight(msg.Height)
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	m.clampScroll()
	return m, nil
}

func (m *menuModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up":
		m.move(-1)
	case "down":
		m.move(1)
	case "enter":
		if len(m.visible) > 0 {
			m.choice = m.visible[m.cursor]
			return m, tea.Quit
		}
	case "ctrl+c":
		m.cancelled = true
		return m, tea.Quit
	case "esc":
		if m.filtering || m.query != "" {
			m.filtering, m.query = false, ""
			m.applyFilter()
		} else {
			m.cancelled = true
			return m, tea.Quit
		}
	default:
		if m.filtering {
			m.handleFilterKey(msg)
		} else {
			m.handleNavKey(msg.String())
		}
	}
	m.clampScroll()
	return m, nil
}

func (m *menuModel) handleFilterKey(msg tea.KeyMsg) {
	switch {
	case msg.String() == "backspace":
		if m.query == "" {
			m.filtering = false
			return
		}
		runes := []rune(m.query)
		m.query = string(runes[:len(runes)-1])
		m.applyFilter()
	case msg.Type == tea.KeyRunes:
		m.query += string(msg.Runes)
		m.applyFilter()
	}
}

func (m *menuModel) handleNavKey(key string) {
	switch key {
	case "k":
		m.move(-1)
	case "j":
		m.move(1)
	case "g", "home":
		m.cursor = 0
	case "G", "end":
		m.cursor = max(0, len(m.visible)-1)
	case "/":
		m.filtering = true
	}
}

func (m *menuModel) View() string {
	// Empty final frame: bubbletea clears the menu on exit and the
	// caller echoes the choice as a single line instead.
	if m.choice >= 0 || m.cancelled {
		return ""
	}
	var b strings.Builder
	b.WriteString(boldErr(m.title) + "\n")
	if m.filtering || m.query != "" {
		b.WriteString("  " + dimErr("/") + m.query + "\n")
	}
	if m.header != "" {
		b.WriteString("  " + dimErr(m.header) + "\n")
	}
	rows := m.visibleRows()
	if m.offset > 0 {
		b.WriteString(dimErr(fmt.Sprintf("  ↑ %d more", m.offset)) + "\n")
	}
	if len(m.visible) == 0 {
		b.WriteString(dimErr("  (no matches)") + "\n")
	}
	for vi := m.offset; vi < m.offset+rows && vi < len(m.visible); vi++ {
		if vi != m.cursor {
			b.WriteString("  " + m.rows[m.visible[vi]] + "\n")
			continue
		}
		line := "▸ " + m.rows[m.visible[vi]]
		if stderrColor {
			line = selectedRow(line)
		}
		b.WriteString(line + "\n")
	}
	if rest := len(m.visible) - m.offset - rows; rest > 0 {
		b.WriteString(dimErr(fmt.Sprintf("  ↓ %d more", rest)) + "\n")
	}
	if m.filtering {
		b.WriteString(dimErr("type to filter · enter select · esc clear"))
	} else {
		b.WriteString(dimErr("↑/↓ move · / filter · enter select · esc cancel"))
	}
	return b.String()
}

// Returns the selected index into rows; initial is the row highlighted
// first. names feed the fallback prompt's type-a-name matching and the
// post-selection echo.
func menuSelect(title, header string, rows []string, names []string, initial int) (int, error) {
	if len(rows) == 0 {
		return -1, errf("Nothing to select from.")
	}
	// bubbletea's Run doesn't fail on a redirected stdin -- it waits
	// forever on input that never comes -- so route non-tty stdio to
	// the numbered prompt up front.
	if !isTerminal(os.Stdin) || !isTerminal(os.Stderr) {
		return menuSelectNumbered(title, rows, names)
	}
	model := &menuModel{title: title, header: header, rows: rows, choice: -1}
	model.filterText = make([]string, len(names))
	for i, name := range names {
		model.filterText[i] = strings.ToLower(name)
	}
	model.applyFilter()
	if initial >= 0 && initial < len(rows) {
		model.cursor = initial
	}
	// Size the very first frame too: bubbletea's initial render lands
	// before its WindowSizeMsg, and an unclamped frame taller than the
	// terminal leaves stale rows behind.
	if _, height := terminalSize(); height > 0 {
		model.setHeight(height)
	}
	model.clampScroll()
	program := tea.NewProgram(model, tea.WithInput(os.Stdin), tea.WithOutput(os.Stderr))
	final, err := program.Run()
	if err != nil {
		if errors.Is(err, tea.ErrInterrupted) {
			return -1, errf("Cancelled.")
		}
		return menuSelectNumbered(title, rows, names)
	}
	result := final.(*menuModel)
	if result.cancelled || result.choice < 0 {
		return -1, errf("Cancelled.")
	}
	note(dimErr(title) + " " + cyanErr(names[result.choice]))
	return result.choice, nil
}

func menuSelectNumbered(title string, rows []string, names []string) (int, error) {
	note(title)
	note("")
	for i, row := range rows {
		note("  " + dimErr(strconv.Itoa(i+1)+".") + " " + row)
	}
	note("")
	reader := bufio.NewReader(os.Stdin)
	for {
		fmt.Fprintf(os.Stderr, "Select [1-%d]: ", len(rows))
		input, err := reader.ReadString('\n')
		if err != nil {
			note("")
			return -1, errf("Cancelled.")
		}
		answer := strings.TrimSpace(input)
		if answer == "" || strings.EqualFold(answer, "q") {
			return -1, errf("Cancelled.")
		}
		if n, convErr := strconv.Atoi(answer); convErr == nil && n >= 1 && n <= len(rows) {
			return n - 1, nil
		}
		for i, name := range names {
			if strings.EqualFold(name, answer) {
				return i, nil
			}
		}
		note(fmt.Sprintf("Enter a number between 1 and %d, a name, or blank to cancel.", len(rows)))
	}
}
