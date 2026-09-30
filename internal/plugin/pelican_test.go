package plugin

import (
	"strings"
	"testing"
)

func TestExtractSVG(t *testing.T) {
	simple := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>`
	nested := `<svg viewBox="0 0 10 10"><svg x="1"><rect/></svg><path d="M0 0"/></svg>`
	cases := []struct {
		name, text, want, err string
	}{
		{"bare", simple, simple, ""},
		{"fenced prose", "Here you go:\n```svg\n" + simple + "\n```\nEnjoy!", simple, ""},
		{"uppercase tags", "<SVG viewBox=\"0 0 1 1\"></SVG>", "<SVG viewBox=\"0 0 1 1\"></SVG>", ""},
		{"nested svg kept whole", "x " + nested + " y", nested, ""},
		{"first of two", simple + "\n" + nested, simple, ""},
		{"html entity allowed", `<svg><text>a&nbsp;b</text></svg>`, `<svg><text>a&nbsp;b</text></svg>`, ""},
		{"no svg", "I cannot draw.", "", "没有 SVG"},
		{"truncated", `<svg viewBox="0 0 1 1"><circle r="1"/>`, "", "缺少 </svg>"},
		{"malformed", `<svg><g></svg>`, "", "无法解析"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := extractSVG(c.text)
			if c.err != "" {
				if err == nil || !strings.Contains(err.Error(), c.err) {
					t.Fatalf("error = %v, want containing %q", err, c.err)
				}
				return
			}
			if err != nil || got != c.want {
				t.Fatalf("got %q, %v; want %q", got, err, c.want)
			}
		})
	}
}

func TestExtractSVGSizeLimit(t *testing.T) {
	big := "<svg>" + strings.Repeat("<g/>", pelicanMaxSVGBytes/4) + "</svg>"
	if _, err := extractSVG(big); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("error = %v, want size limit", err)
	}
}
