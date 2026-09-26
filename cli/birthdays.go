package main

// Villager birthdays, for the name pick: with Village life on, a
// villager whose birthday it is (local date) is invited first. The
// birthdays come from the villager data the app downloads into the data
// dir (app/host/lib/villagers.ts writes villagers/ready/profiles.json
// once a download is whole), so without it there is no one to invite.
// The same rules as the app's shared/villagers/birthdays.ts.

import (
	"path/filepath"
	"sort"
	"time"
)

// Matches villageLifeEnabled in the app's shared/villageLife.ts: only
// with Doubutsu names on, and off unless set.
func villageLifeEnabled(global globalConfig) bool {
	return doubutsuNamesEnabled(global) && global.VillageLife != nil && *global.VillageLife
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

// The villagers celebrating on `day`, sorted, from the downloaded
// profiles. Empty without Village life or the data: a missing or
// unreadable file just means nobody is invited.
func birthdayGuests(global globalConfig, day time.Time) []string {
	if !villageLifeEnabled(global) {
		return nil
	}
	profiles, ok := readJSONFile[map[string]struct {
		Birthday string `json:"birthday"`
	}](filepath.Join(dataDir(), "villagers", "ready", "profiles.json"))
	if !ok {
		return nil
	}
	var guests []string
	for slug, profile := range profiles {
		if isBirthdayOn(profile.Birthday, day) {
			guests = append(guests, slug)
		}
	}
	sort.Strings(guests)
	return guests
}
