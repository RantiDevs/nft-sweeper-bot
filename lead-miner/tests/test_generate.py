from pathlib import Path

import pytest

from lead_miner.generate import build_queries, load_and_build, read_csv, read_patterns

DATA = Path(__file__).resolve().parent.parent / "data"

PLATFORMS = [{"platform": "wixsite.com"}, {"platform": "weebly.com"}]
NICHES = [{"niche": "dentist", "tier": "1"}, {"niche": "florist", "tier": "2"}]
LOCATIONS = [{"location": "Toronto", "country": "Canada"}]


def test_base_formula():
    qs = build_queries(PLATFORMS, NICHES, LOCATIONS)
    assert [q["query"] for q in qs] == [
        'site:wixsite.com "dentist" "Toronto"',
        'site:wixsite.com "florist" "Toronto"',
        'site:weebly.com "dentist" "Toronto"',
        'site:weebly.com "florist" "Toronto"',
    ]
    assert qs[0]["country"] == "Canada" and qs[0]["tier"] == "1" and qs[0]["platform"] == "wixsite.com"


def test_patterns_without_platform_are_not_multiplied_by_platforms():
    patterns = [{"pattern": '"© 2015" "{niche}" "{location}"', "signal": "outdated"}]
    qs = build_queries(PLATFORMS, NICHES, LOCATIONS, patterns, include_base=False)
    assert [q["query"] for q in qs] == ['"© 2015" "dentist" "Toronto"', '"© 2015" "florist" "Toronto"']
    assert qs[0]["pattern"] == "outdated" and qs[0]["platform"] is None


def test_patterns_with_platform_and_exclude():
    patterns = [{"pattern": 'site:{platform} "{niche}" "{location}" "book now"'}]
    qs = build_queries(PLATFORMS[:1], NICHES[:1], LOCATIONS, patterns, include_base=False, exclude="-template")
    assert qs[0]["query"] == 'site:wixsite.com "dentist" "Toronto" "book now" -template'


def test_duplicates_removed():
    qs = build_queries(PLATFORMS, NICHES, LOCATIONS + LOCATIONS)
    assert len(qs) == 4


def test_read_patterns_txt(tmp_path):
    f = tmp_path / "weak.txt"
    f.write_text('# comment\n\n"best viewed in" "{niche}" "{location}"  # old_browser\n"{niche}" "{location}" "@gmail.com"\n')
    pats = read_patterns(f)
    assert pats == [
        {"pattern": '"best viewed in" "{niche}" "{location}"', "signal": "old_browser"},
        {"pattern": '"{niche}" "{location}" "@gmail.com"', "signal": "weak"},
    ]


def test_read_csv_requires_column(tmp_path):
    f = tmp_path / "x.csv"
    f.write_text("name\nfoo\n")
    with pytest.raises(ValueError):
        read_csv(f, "niche")


def test_shipped_data_filters():
    qs = load_and_build(DATA, [DATA / "patterns" / "weakness.txt"], countries=["Ireland"],
                        niches_filter=["dentist"], platforms_filter=["wixsite.com"])
    texts = {q["query"] for q in qs}
    assert 'site:wixsite.com "dentist" "Dublin"' in texts
    assert '"© 2014" "dentist" "Dublin"' in texts
    assert all(q["country"] == "Ireland" for q in qs)
    tier1 = load_and_build(DATA, tiers=["1"], countries=["Qatar"])
    assert tier1 and all(q["tier"] == "1" for q in tier1)
