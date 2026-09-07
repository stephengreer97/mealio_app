"""Read ~/store_logins.txt.

NEVER PRINTS A VALUE. Every accessor returns the secret for typing into the
device and nothing here logs it; the only things that reach a terminal are the
store name, which field was found, and a length. The file lives outside the repo
so it cannot be committed from here, and nothing in this module writes it
anywhere.
"""
import os, re

PATH = os.path.expanduser('~/store_logins.txt')

def _blocks():
    t = open(PATH, encoding='utf8', errors='replace').read().replace('\r', '')
    for b in re.split(r'\n\s*\n', t):
        lines = [l.strip() for l in b.strip().split('\n') if l.strip()]
        if lines:
            yield lines

def _repair_domain(email, others):
    """Complete a domain that is missing its TLD.

    Two entries in the file read "...@gmail" where the other six read
    "...@gmail.com". The store rejects it as an invalid address, which looks
    exactly like a typing bug in the harness and cost a run to tell apart.

    Only ever completes from ANOTHER ENTRY IN THE SAME FILE with the identical
    local part -- it does not invent a domain, and it leaves anything it cannot
    corroborate untouched so a genuinely different address is never rewritten.
    """
    if not email or '@' not in email:
        return email, False
    loc, _, dom = email.partition('@')
    if '.' in dom:
        return email, False
    for other in others:
        oloc, _, odom = (other or '').partition('@')
        if oloc == loc and odom.startswith(dom + '.'):
            return loc + '@' + odom, True
    return email, False


def for_store(name):
    """{'store', 'email', 'password', 'note'} for a store, matched loosely so
    'aldi' finds 'ALDI' and 'heb' finds 'HEB'."""
    want = re.sub(r'[^a-z]', '', name.lower())
    for lines in _blocks():
        have = re.sub(r'[^a-z]', '', lines[0].lower())
        if want and (want in have or have in want):
            out = {'store': lines[0], 'note': lines[-1] if len(lines) > 2 else ''}
            for l in lines[1:]:
                if '@' in l and 'email' not in out:
                    out['email'] = l
                elif l is not out.get('note') and 'password' not in out and '@' not in l:
                    out['password'] = l
            allmails = []
            for other in _blocks():
                for l in other[1:]:
                    if '@' in l:
                        allmails.append(l)
            fixed, did = _repair_domain(out.get('email', ''), allmails)
            if did:
                out['email'] = fixed
                out['email_repaired'] = True
            return out
    return None

def describe(name):
    """What we hold for a store, safe to print: presence and lengths only."""
    c = for_store(name)
    if not c:
        return '%s: NOT IN FILE' % name
    return '%s: email=%s password=%s note=%r' % (
        c['store'],
        ('yes(%d)' % len(c['email'])) if c.get('email') else 'no',
        ('yes(%d)' % len(c['password'])) if c.get('password') else 'no',
        (('REPAIRED domain; ' if c.get('email_repaired') else '') + c.get('note', ''))[:60])

if __name__ == '__main__':
    for s in ['HEB', 'Albertsons', 'Kroger', 'Amazon Fresh', 'ALDI', 'Walmart', 'Wegmans', 'Publix']:
        print(' ', describe(s))
