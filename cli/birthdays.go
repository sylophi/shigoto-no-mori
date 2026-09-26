package main

// Villager birthdays, for the name pick: with prioritizeBirthdays on, a
// villager whose birthday it is (local date) is invited first. The
// birthdays ship with the names (embed/doubutsu-names.json, see
// names.go), so the invite needs no villager data. The same date rules
// as the app's shared/villagers/birthdays.ts.

import (
	"sort"
	"time"
)

// Only with Doubutsu names on, and off unless set: the invite is a
// pick from the doubutsu pool.
func prioritizeBirthdaysEnabled(global globalConfig) bool {
	return doubutsuNamesEnabled(global) && global.PrioritizeBirthdays != nil && *global.PrioritizeBirthdays
}

// Whether a "MM-DD" birthday falls on the local calendar day of `day`.
// A leap-day birthday is kept on Feb 28 in years without a Feb 29.
func isBirthdayOn(birthday string, day time.Time) bool {
	today := day.Format("01-02")
	if birthday == today {
		return true
	}
	year := day.Year()
	leap := year%4 == 0 && (year%100 != 0 || year%400 == 0)
	return birthday == "02-29" && today == "02-28" && !leap
}

// The villagers celebrating on `day`, sorted. Empty with
// prioritizeBirthdays off.
func birthdayGuests(global globalConfig, day time.Time) []string {
	if !prioritizeBirthdaysEnabled(global) {
		return nil
	}
	return celebrating(doubutsuPool(), day)
}

// Whoever in `pool` celebrates on `day`, sorted. A character without a
// birthday never does.
func celebrating(pool map[string]doubutsuName, day time.Time) []string {
	var guests []string
	for slug, entry := range pool {
		if isBirthdayOn(entry.Birthday, day) {
			guests = append(guests, slug)
		}
	}
	sort.Strings(guests)
	return guests
}
