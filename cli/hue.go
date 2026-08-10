package main

// Per-project accent color, for projects whose logo resolves
// (icon.go): the accent is "the logo's color", so projects without
// one stay uncolored.
//
// All color math runs in OKLab/OKLCH (Björn Ottosson's perceptual
// space): hue extraction weights samples by OKLab chroma -- how
// colorful they *look*, not how far their RGB is from gray -- and
// rendering fixes perceptual lightness and chroma, so every accent
// reads equally bright regardless of hue (HSL can't promise that:
// its yellows glare and its blues recede at the same L). termenv's
// color profile picks the depth: truecolor terminals get the exact
// OKLCH pastel, others the nearest 256- or 16-color approximation.
//
// Extraction: SVGs are scanned for declared colors (hex and rgb()),
// rasters (PNG/GIF/JPEG, plus PNG members of ICOs) are sampled on a
// grid. Either way the chromatic weight lands in 15-degree hue buckets
// and the heaviest bucket wins; near-grays, near-black and near-white
// carry no chroma and thus no weight, so a monochrome logo yields no
// accent at all rather than a junk hue.

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"regexp"
	"strconv"
	"sync"
)

// --- OKLCH color math ---

func srgbToLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func linearToSRGB(c float64) float64 {
	c = math.Max(0, math.Min(1, c))
	if c <= 0.0031308 {
		return 12.92 * c
	}
	return 1.055*math.Pow(c, 1/2.4) - 0.055
}

// sRGB [0,1] -> OKLCH: perceptual lightness [0,1], chroma (~0..0.3 for
// sRGB colors), hue in degrees.
func srgbToOKLCh(r, g, b float64) (float64, float64, float64) {
	lr, lg, lb := srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)
	l := math.Cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb)
	m := math.Cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb)
	s := math.Cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb)
	lightness := 0.2104542553*l + 0.7936177850*m - 0.0040720468*s
	a := 1.9779984951*l - 2.4285922050*m + 0.4505937099*s
	bb := 0.0259040371*l + 0.7827717662*m - 0.8086757660*s
	chroma := math.Hypot(a, bb)
	hue := math.Atan2(bb, a) * 180 / math.Pi
	return lightness, chroma, math.Mod(hue+360, 360)
}

// OKLCH -> sRGB [0,1], clamped into gamut (at the muted chroma used
// here every hue fits; the clamp is a safety net).
func oklchToSRGB(lightness, chroma, hue float64) (float64, float64, float64) {
	rad := hue * math.Pi / 180
	a, bb := chroma*math.Cos(rad), chroma*math.Sin(rad)
	l3 := lightness + 0.3963377774*a + 0.2158037573*bb
	m3 := lightness - 0.1055613458*a - 0.0638541728*bb
	s3 := lightness - 0.0894841775*a - 1.2914855480*bb
	l, m, s := l3*l3*l3, m3*m3*m3, s3*s3*s3
	return linearToSRGB(4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
		linearToSRGB(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
		linearToSRGB(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)
}

// The accent look: one perceptual lightness and chroma for every
// project, only the hue varies. Muted on purpose -- an accent, not a
// highlight -- and matched to the terminal background: pastels for
// dark themes, deeper tones for light ones (a light pastel vanishes
// on white).
func accentLC() (float64, float64) {
	if darkBackground() {
		return 0.80, 0.10
	}
	return 0.52, 0.12
}

// SGR code (for paint) rendering the given OKLCH hue at the fixed
// accent lightness/chroma, quantized by termenv to the depth the
// terminal supports ("" when it supports none).
func hueToCode(hue float64) string {
	lightness, chroma := accentLC()
	r, g, b := oklchToSRGB(lightness, chroma, math.Mod(hue+360, 360))
	accent := colorProfile().FromColor(color.RGBA{
		R: uint8(math.Round(r * 255)),
		G: uint8(math.Round(g * 255)),
		B: uint8(math.Round(b * 255)),
		A: 255,
	})
	if accent == nil {
		return ""
	}
	return accent.Sequence(false)
}

// --- dominant hue ---

// 15-degree buckets accumulate chromatic weight; the winner and its
// neighbors average into the final hue (vector mean handles the 0/360
// wrap). minWeight keeps a lone speck of color in an otherwise
// monochrome icon from deciding anything.
type hueAccum struct {
	weight [24]float64
	x, y   [24]float64
	total  float64
}

func (a *hueAccum) add(h, w float64) {
	if w <= 0 {
		return
	}
	bucket := int(h/15) % 24
	rad := h * math.Pi / 180
	a.weight[bucket] += w
	a.x[bucket] += w * math.Cos(rad)
	a.y[bucket] += w * math.Sin(rad)
	a.total += w
}

func (a *hueAccum) dominant(minWeight float64) (float64, bool) {
	if a.total < minWeight {
		return 0, false
	}
	best := 0
	for i := range a.weight {
		if a.weight[i] > a.weight[best] {
			best = i
		}
	}
	x := a.x[best] + a.x[(best+1)%24] + a.x[(best+23)%24]
	y := a.y[best] + a.y[(best+1)%24] + a.y[(best+23)%24]
	if x == 0 && y == 0 {
		return 0, false
	}
	hue := math.Atan2(y, x) * 180 / math.Pi
	return math.Mod(hue+360, 360), true
}

// Weight of one color: its OKLab chroma, gated so near-gray (chroma
// under ~0.03) and near-black/near-white contribute nothing. Saturated
// sRGB colors land around 0.12-0.29.
func chromaticWeight(lightness, chroma float64) float64 {
	if chroma < 0.03 || lightness < 0.15 || lightness > 0.97 {
		return 0
	}
	return chroma
}

var (
	svgHexRe = regexp.MustCompile(`#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b`)
	svgRGBRe = regexp.MustCompile(`rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?`)
)

// The regexes guarantee valid hex digits, so no error paths.
func hexDigit(c byte) float64 {
	switch {
	case c <= '9':
		return float64(c - '0')
	case c >= 'a':
		return float64(c-'a') + 10
	default:
		return float64(c-'A') + 10
	}
}

func hexNibble(c byte) float64 { return hexDigit(c) * 17 / 255 }
func hexPair(s string) float64 { return (hexDigit(s[0])*16 + hexDigit(s[1])) / 255 }

func svgHue(data []byte) (float64, bool) {
	var acc hueAccum
	text := string(data)
	// Declared alpha scales the weight: an invisible color must not
	// vote on the dominant hue.
	for _, m := range svgHexRe.FindAllStringSubmatch(text, -1) {
		hex := m[1]
		var r, g, b float64
		alpha := 1.0
		switch len(hex) {
		case 3, 4: // #rgb / #rgba
			r, g, b = hexNibble(hex[0]), hexNibble(hex[1]), hexNibble(hex[2])
			if len(hex) == 4 {
				alpha = hexNibble(hex[3])
			}
		default: // #rrggbb / #rrggbbaa
			r, g, b = hexPair(hex[0:2]), hexPair(hex[2:4]), hexPair(hex[4:6])
			if len(hex) == 8 {
				alpha = hexPair(hex[6:8])
			}
		}
		lightness, chroma, h := srgbToOKLCh(r, g, b)
		acc.add(h, chromaticWeight(lightness, chroma)*alpha)
	}
	for _, m := range svgRGBRe.FindAllStringSubmatch(text, -1) {
		r, _ := strconv.Atoi(m[1])
		g, _ := strconv.Atoi(m[2])
		b, _ := strconv.Atoi(m[3])
		if r > 255 || g > 255 || b > 255 {
			continue
		}
		alpha := 1.0
		if m[4] != "" {
			if a, err := strconv.ParseFloat(m[4], 64); err == nil {
				alpha = math.Max(0, math.Min(1, a))
			}
		}
		lightness, chroma, h := srgbToOKLCh(float64(r)/255, float64(g)/255, float64(b)/255)
		acc.add(h, chromaticWeight(lightness, chroma)*alpha)
	}
	// One modestly chromatic declared color is enough.
	return acc.dominant(0.04)
}

func rasterHue(data []byte) (float64, bool) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 ||
		config.Width*config.Height > 16_000_000 {
		return 0, false
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return 0, false
	}
	bounds := img.Bounds()
	strideX := max(1, bounds.Dx()/64)
	strideY := max(1, bounds.Dy()/64)
	var acc hueAccum
	samples := 0.0
	for y := bounds.Min.Y; y < bounds.Max.Y; y += strideY {
		for x := bounds.Min.X; x < bounds.Max.X; x += strideX {
			r16, g16, b16, a16 := img.At(x, y).RGBA()
			if a16 < 0x2000 {
				continue
			}
			samples++
			// RGBA() is alpha-premultiplied; un-premultiply first.
			r := float64(r16) / float64(a16)
			g := float64(g16) / float64(a16)
			b := float64(b16) / float64(a16)
			lightness, chroma, h := srgbToOKLCh(r, g, b)
			acc.add(h, chromaticWeight(lightness, chroma)*float64(a16)/0xffff)
		}
	}
	// Roughly 2% of sampled pixels at saturated chroma (~0.15), so a
	// stray colored pixel in a grayscale logo doesn't win.
	return acc.dominant(math.Max(0.08, samples*0.003))
}

var (
	pngMagic = []byte{0x89, 'P', 'N', 'G'}
	icoMagic = []byte{0x00, 0x00, 0x01, 0x00}
)

// ICO is a container; modern favicons usually embed PNG members, which
// stdlib can decode. BMP members are skipped (not worth a decoder).
func icoLargestPNG(data []byte) []byte {
	if len(data) < 6 || !bytes.HasPrefix(data, icoMagic) {
		return nil
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	var best []byte
	for i := range count {
		dir := 6 + i*16
		if dir+16 > len(data) {
			break
		}
		size := int(binary.LittleEndian.Uint32(data[dir+8 : dir+12]))
		offset := int(binary.LittleEndian.Uint32(data[dir+12 : dir+16]))
		if size < 8 || offset < 0 || offset+size > len(data) {
			continue
		}
		member := data[offset : offset+size]
		if bytes.HasPrefix(member, pngMagic) && size > len(best) {
			best = member
		}
	}
	return best
}

// Sniffed by content, not extension -- plenty of favicon.ico files are
// really PNGs.
func iconHue(iconPath string) (float64, bool) {
	info, err := os.Stat(iconPath)
	if err != nil || info.Size() > 2<<20 {
		return 0, false
	}
	data, err := os.ReadFile(iconPath)
	if err != nil {
		return 0, false
	}
	switch {
	case bytes.HasPrefix(data, icoMagic):
		if member := icoLargestPNG(data); member != nil {
			return rasterHue(member)
		}
		return 0, false
	case bytes.HasPrefix(data, pngMagic),
		bytes.HasPrefix(data, []byte("GIF8")),
		bytes.HasPrefix(data, []byte{0xff, 0xd8}):
		return rasterHue(data)
	case bytes.Contains(data, []byte("<svg")):
		// After the raster magics so a binary that happens to contain
		// "<svg" can't be misread; SVG preambles (licenses, DOCTYPE)
		// can push the tag arbitrarily deep, so scan the whole file.
		return svgHue(data)
	default:
		return rasterHue(data)
	}
}

// --- per-project memo ---

var projectColorMemo sync.Map // project ID -> SGR code string

// SGR code for the project's accent color, "" when the project has no
// (chromatic) logo -- the accent means "this is the logo's color", so
// icon-less projects stay uncolored rather than getting an arbitrary
// one. Cheap after the first call per project; prefetchProjectColors
// front-loads the icon work.
func projectColorCode(proj project) string {
	if code, ok := projectColorMemo.Load(proj.ID); ok {
		return code.(string)
	}
	code := ""
	if iconPath := resolveProjectIcon(proj.Path); iconPath != "" {
		if hue, ok := iconHue(iconPath); ok {
			code = hueToCode(hue)
		}
	}
	projectColorMemo.Store(proj.ID, code)
	return code
}

// Resolve every project's color concurrently before a picker or table
// renders -- resolution may shell out to git once per project, so the
// fan-out is capped rather than one subprocess per project at once.
func prefetchProjectColors(projects []project) {
	semaphore := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, proj := range projects {
		wg.Add(1)
		go func() {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			projectColorCode(proj)
		}()
	}
	wg.Wait()
}
