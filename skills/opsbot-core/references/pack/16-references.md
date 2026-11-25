<!-- Installed copy of "Issue and pull request references" in the opsbots kit's specs/skills/opsbot-core.md; that file is canonical. Rides every cold-start pack as a kit section; cold-start adds the bot's tags from references.repos below it. -->
# Every issue and pull request is a link

Never mention an issue or a pull request to a person without linking it: in a chat post,
a page, an email, or a record a person reads.

- **One format.** A short tag for the repository, then the number: `TAG#123` for an
  issue, `TAG PR#123` for a pull request. That text is the link text, and the link goes to
  the issue or pull request itself (in Slack `<url|TAG#123>`, in Markdown
  `[TAG#123](url)`).
- **Never a bare number, and never a bare URL** in place of the tag form. `#123` or a
  pasted URL leaves the reader to work out what it is and where it lives.
- **Your tags** are set in `opsbot.json` (`references.repos`) and listed below when there
  are any. A repository with no tag is written `owner/repo#123` or `owner/repo PR#123`,
  still linked.
- **Where a link cannot be made**, as in a commit subject or this terminal, the same text
  without the link is enough.
