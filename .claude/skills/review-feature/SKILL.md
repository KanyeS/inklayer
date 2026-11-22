---
name: review-feature
description: Review a web page or feature in a real browser and leave Inklayer comments on what's wrong, with screenshots, page details and recordings, using the inklayer-review MCP tools. Use when asked to review, QA, test or try a page, feature or flow and report findings as Inklayer comments, or to "comment on" or "record" a bug on a site.
---

# Reviewing a feature with Inklayer comments

The `inklayer-review` MCP server drives a browser and posts Inklayer comments as the signed-in person (see client/apps/review/README.md). If its tools aren't available, tell the person how to add it (that README's "Set up") and stop.

## Steps

1. **Scope.** Work out what to review: the address, the feature or flow, and what "working" means. Read the relevant code or docs if it's this repository's feature. If you can't tell which environment to use (local, staging, production), ask.
2. **Look.** Use `open_page`, then `page_outline` to see the structure. Take a `screenshot` whenever the layout matters.
3. **Try it like a person would.** Use `click`, `fill`, `press` and `scroll`. Cover the main path, then edge cases: empty and long input, invalid values, going back, reloading, and a narrow window (`open_page` with `width: 390, height: 844`).
4. **Record problems that happen over time.** Use `start_recording` before reproducing one, and `stop_recording` straight after, keeping it under a minute. The next `comment` gets the video. Don't record static problems: the screenshot is enough.
5. **Comment on each finding.** Use `comment` on the element it's about (the button, the field, the broken layout), not the whole page.
   - **One problem per comment**, so each can be resolved on its own.
   - **Say what's wrong** in the first line. It becomes the issue title if someone makes an issue from it.
   - **Then the details:** the steps, then expected and actual behaviour. Mention console errors or failed requests if you saw them; the page details are attached anyway.
   - **Be specific and neutral.** Don't guess at causes you haven't checked.
   - **Several projects:** if `comment` asks for a `project_id`, use `list_projects` and pick the project for this site. Ask the person if it's unclear.
6. **Don't comment on what works.** Collect minor polish notes into one comment, or mention them in your summary instead.
7. **Finish.** Use `close_browser`. Then give the person a short summary: what you tried, each comment with its first line, and anything you couldn't check.

## Cautions

- **The comments are real:** they're posted as the person, and their team sees them. Only comment on actual findings, and never post test or placeholder comments.
- **Data on real sites:** don't submit forms that create, change or delete real data, buy anything, or send messages, unless the person says that environment is safe for it.
- **Signing in:** the browser has its own profile and starts signed out of the site being reviewed. If the page needs a login, ask the person how to sign in, or for a test account. Never type their real passwords from memory or guess them.
