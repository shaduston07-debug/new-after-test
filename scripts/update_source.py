#!/usr/bin/env python3
"""Rebuild flekstore.json from the newest GitHub release of each app.

For every app it finds the release that holds the app's .ipa and fills in the
version, date, size and download link, so Flekstore sees new builds as updates.
Run by .github/workflows/update-source.yml; can also be run by hand.
"""
import json
import os
import re
import urllib.request

OWNER = "shaduston07-debug"
OUT = os.path.join(os.path.dirname(__file__), "..", "flekstore.json")


def raw(repo, branch, path):
    return f"https://raw.githubusercontent.com/{OWNER}/{repo}/{branch}/{path}"


# tag=None means "the repo's newest release that has the .ipa".
APPS = [
    dict(
        name="Inkwell Studio", bundleIdentifier="com.inkwell.studio",
        repo="test-01", tag="latest", asset="InkwellStudio.ipa", minOSVersion="15.0",
        subtitle="Paint, animate and make webtoons", tintColor="#7b5cff",
        iconURL="https://shaduston07-debug.github.io/test-01/icons/icon-512.png",
        localizedDescription="A painting, animation and webtoon app for iPad and Apple Pencil, "
        "with Illustrate, Animate and Webtoon modes and Inkwell Learning courses.",
        # Studio's own build writes its exact version here.
        versionFrom=raw("test-01", "download", "sidestore.json"),
    ),
    dict(
        name="Inkwell Notes", bundleIdentifier="app.inkwell.notes",
        repo="test-01", tag="ipa-latest", asset="Inkwell.ipa", minOSVersion="15.0",
        subtitle="Notes with definitions and translations", tintColor="#C8102E",
        iconURL=raw("test-01", "claude/notes-spell-check-definitions-q0ppqf",
                    "ios/Inkwell/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"),
        localizedDescription="A notes app in the style of Apple Notes, with spell check, dictionary "
        "definitions, translations (Old Norse, Latin, Greek, argot, Lingala, Tshiluba), Pencil "
        "sketches, recordings and pictures.",
    ),
    dict(
        name="Inkwell Browser", bundleIdentifier="com.mangashaduston.inkwellbrowser",
        repo="browser", tag="latest", asset="InkwellBrowser.ipa", minOSVersion="18.4",
        subtitle="Desktop browser with extensions", tintColor="#2F6FEB",
        iconURL=raw("browser", "main", "ci/Assets.xcassets/AppIcon.appiconset/icon-1024.png"),
        localizedDescription="A desktop-class browser for iPad: real Chrome and Firefox extensions, "
        "desktop websites, a Mac-style tab strip and keyboard shortcuts. Requires iPadOS 18.4 or later.",
    ),
    dict(
        name="Inkwell Drop", bundleIdentifier="com.mangashaduston.inkwelldrop",
        repo="connectivity", tag="latest", asset="InkwellDrop.ipa", minOSVersion="16.0",
        subtitle="Share files with Android and iOS", tintColor="#14A37F",
        iconURL=raw("connectivity", "claude/funny-bell-yi3gy2",
                    "ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png"),
        localizedDescription="AirDrop-style sharing between iPhone, iPad and Android over Bluetooth, "
        "with automatic hand-off to Wi-Fi. No account, no internet, no pairing.",
    ),
    dict(
        name="Inkfinity", bundleIdentifier="app.draftwell.sketch",
        repo="conceptlike-app", tag=None, asset="Inkfinity.ipa", minOSVersion="15.0",
        subtitle="Infinite-canvas vector sketching", tintColor="#7A4CE0",
        iconURL=raw("conceptlike-app", "claude/draftwell-ipad-app",
                    "ios/Inkfinity/Assets.xcassets/AppIcon.appiconset/icon-1024.png"),
        localizedDescription="An infinite-canvas vector sketching app for iPad and Apple Pencil: "
        "pressure-aware brushes, live shapes, perspective guides, layers, and PNG/SVG/PDF/PSD export.",
    ),
]


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "flekstore-source-updater"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def find_release(app):
    base = f"https://api.github.com/repos/{OWNER}/{app['repo']}/releases"
    releases = [get(f"{base}/tags/{app['tag']}")] if app["tag"] else get(f"{base}?per_page=20")
    for rel in releases:
        if rel.get("draft"):
            continue
        for asset in rel.get("assets", []):
            if asset["name"] == app["asset"]:
                return rel, asset
    raise RuntimeError(f"{app['name']}: no release with {app['asset']}")


def version_for(app, rel, asset):
    """Return (version, build). Versions always grow, so Flekstore shows updates."""
    if app.get("versionFrom"):
        try:
            v = get(app["versionFrom"])["apps"][0]["versions"][0]
            return v["version"], str(v.get("buildVersion") or v["version"].split(".")[-1])
        except Exception as e:  # fall back to the release itself
            print(f"  {app['name']}: could not read {app['versionFrom']} ({e})")
    m = re.search(r"build[\s-]*(\d+)", f"{rel.get('name') or ''} {rel['tag_name']}", re.I)
    if m:
        return f"1.0.{m.group(1)}", m.group(1)
    # No build number anywhere: use the upload time, e.g. 1.0.202611082308.
    stamp = re.sub(r"\D", "", asset["updated_at"])[:12]
    return f"1.0.{stamp}", stamp


def main():
    apps = []
    for app in APPS:
        rel, asset = find_release(app)
        version, build = version_for(app, rel, asset)
        date = asset["updated_at"][:10]
        url = asset["browser_download_url"]
        sha = (rel.get("target_commitish") or "")[:7]
        notes = f"Build {build}" + (f" from {sha}" if re.fullmatch(r"[0-9a-f]{7}", sha) else "") + "."
        print(f"{app['name']}: {version} ({date}) {url}")
        apps.append(dict(
            name=app["name"], bundleIdentifier=app["bundleIdentifier"], developerName="shaduston07",
            subtitle=app["subtitle"], localizedDescription=app["localizedDescription"],
            iconURL=app["iconURL"], tintColor=app["tintColor"], category="utilities",
            screenshotURLs=[],
            # Older-format fields, for sideloaders that read these instead of "versions".
            version=version, versionDate=date, downloadURL=url, size=asset["size"],
            minOSVersion=app["minOSVersion"],
            versions=[dict(version=version, buildVersion=build, date=date, downloadURL=url,
                           size=asset["size"], minOSVersion=app["minOSVersion"],
                           localizedDescription=notes)],
            appPermissions={},
        ))
    source = dict(
        name="Inkwell Apps", identifier="io.github.shaduston07-debug.inkwell",
        subtitle="Apps by shaduston07",
        description="Unsigned builds of " + ", ".join(a["name"] for a in apps[:-1])
        + f" and {apps[-1]['name']}.",
        iconURL=apps[1]["iconURL"], website=f"https://github.com/{OWNER}", tintColor="#C8102E",
        apps=apps, news=[],
    )
    with open(OUT, "w") as f:
        json.dump(source, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
