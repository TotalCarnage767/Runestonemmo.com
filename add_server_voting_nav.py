import os, re

# The old Community dropdown block (without Server Voting)
OLD_DROPDOWN = '''          <a class="dropdown-link" href="/news.html">📰 PATCH NOTES & NEWS</a>
          <a class="dropdown-link" href="/voting.html">🗳️ COMMUNITY VOTING</a>
          <a class="dropdown-link" href="/bug-report.html">🐛 BUG REPORTS</a>
          <a class="dropdown-link" href="/guides.html">📖 GUIDES & COMMANDS</a>'''

# The new Community dropdown block (with Server Voting added)
NEW_DROPDOWN = '''          <a class="dropdown-link" href="/news.html">📰 PATCH NOTES & NEWS</a>
          <a class="dropdown-link" href="/voting.html">🗳️ COMMUNITY VOTING</a>
          <a class="dropdown-link" href="/server-voting.html">🏆 SERVER VOTING</a>
          <a class="dropdown-link" href="/bug-report.html">🐛 BUG REPORTS</a>
          <a class="dropdown-link" href="/guides.html">📖 GUIDES & COMMANDS</a>'''

# Also update footers to include server-voting link
OLD_FOOTER_VOTING = '<a href="/voting.html">Community Voting</a>'
NEW_FOOTER_VOTING = '<a href="/voting.html">Community Voting</a>\n    <a href="/server-voting.html">Server Voting</a>'

html_files = [f for f in os.listdir('.') if f.endswith('.html') and f != 'server-voting.html']
updated = []
skipped = []

for fname in sorted(html_files):
    with open(fname, 'r', encoding='utf-8') as f:
        content = f.read()
    
    new_content = content
    changed = False
    
    # Update dropdown if old form present
    if OLD_DROPDOWN in new_content:
        new_content = new_content.replace(OLD_DROPDOWN, NEW_DROPDOWN, 1)
        changed = True
    
    # Update footer if old form present and new not already there
    if OLD_FOOTER_VOTING in new_content and 'server-voting.html' not in new_content:
        new_content = new_content.replace(OLD_FOOTER_VOTING, NEW_FOOTER_VOTING, 1)
        changed = True
    
    if changed:
        with open(fname, 'w', encoding='utf-8') as f:
            f.write(new_content)
        updated.append(fname)
    else:
        skipped.append(fname)

print(f"Updated {len(updated)} pages:")
for f in updated:
    print(f"  ✓ {f}")
print(f"\nSkipped {len(skipped)} pages (already correct or no match):")
for f in skipped:
    print(f"  - {f}")
