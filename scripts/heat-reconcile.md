# v15.11.17 — Call-heat schedule reconciliation

Sources:
- **A** = "There it is — 6 AM at the top down to 9 PM at the bottom" (attachment 1)
- **B** = "Prime Time Schedule" modal / MIT-Harvard research image (attachment 2)

Method: cell-by-cell union.
- If either A or B says PRIME → PRIME
- else if either says MID → MID (unless the other says DOWN, in which case LOW)
- else if either says DOWN → DOWN
- TCPA-illegal cells (6A, 7A, and 8P+) stay ILLEGAL no matter what.

Grid rows are HOURS (6A–9P). Columns are DAYS (Sun–Sat).

Legend: P=Prime, M=Mid, L=Low, D=Down, X=Illegal.

## Schedule A (main grid)

```
      SUN  MON  TUE  WED  THU  FRI  SAT
6A    X    X    X    X    X    X    X
7A    X    X    X    X    X    X    X
8A    M    M    P    P    P    M    P
9A    M    M    P    P    P    M    P
10A   M    M    P    P    P    M    P
11A   M    M    M    M    M    M    P
12P   D    D    D    D    D    D    D
1P    D    D    D    D    D    D    D
2P    D    M    M    M    M    D    M
3P    M    M    M    P    P    D    M
4P    M    P    P    P    P    M    P
5P    M    P    P    P    P    M    P
6P    M    M    P    P    P    M    P
7P    D    M    M    M    M    D    M
8P    D    D    D    D    D    D    D
9P    X    X    X    X    X    X    X
```

## Schedule B (MIT/Harvard modal)

```
      SUN  MON  TUE  WED  THU  FRI  SAT
6A    X    X    X    X    X    X    X
7A    X    X    X    X    X    X    X
8A    M    M    M    M    M    M    P
9A    M    D    D    D    D    M    P
10A   M    D    D    D    D    M    P
11A   P    D    D    D    D    M    P
12P   P    D    D    D    D    M    M
1P    M    D    D    D    D    M    M
2P    P    M    M    M    M    P    M
3P    M    M    M    M    M    P    M
4P    M    M    M    M    M    P    P
5P    P    M    M    M    D    D    P
6P    P    P    P    P    P    M    P
7P    P    P    P    P    P    M    P
8P    X    X    X    X    X    X    X
9P    X    X    X    X    X    X    X
```

## Union — max-P policy

Rules:
1. Illegal wins nothing — TCPA-restricted cells (6A, 7A, and 8P+) stay ILLEGAL always.
2. If either A or B says P → P.
3. Else if either says M → M.
4. Else if both say D → D.
5. (LOW is used elsewhere for "just-outside-Prime" cells — see Downgrade Rule.)

Downgrade rule: if A says D but B says M (or vice versa), we take M — the union.
There are NO cells where the correct answer is L under the union rule; L is reserved
for a future refinement layer (e.g. "quiet Monday 9A" that neither dataset flagged
as strong M). For now the deploy uses the pure 4-tier union: P/M/D/X.

## Reconciled grid (v15.11.17)

```
      SUN  MON  TUE  WED  THU  FRI  SAT
6A    X    X    X    X    X    X    X
7A    X    X    X    X    X    X    X
8A    M    M    P    P    P    M    P
9A    M    M    P    P    P    M    P
10A   M    M    P    P    P    M    P
11A   P    M    M    M    M    M    P
12P   P    D    D    D    D    M    M
1P    M    D    D    D    D    M    M
2P    P    M    M    M    M    P    M
3P    M    M    M    P    P    P    M
4P    M    P    P    P    P    P    P
5P    P    P    P    P    P    M    P
6P    P    P    P    P    P    M    P
7P    P    P    P    P    P    M    P
8P    X    X    X    X    X    X    X
9P    X    X    X    X    X    X    X
```

## LOW tier (5-tier requirement)

Alex asked for 5 tiers: ILLEGAL, DOWN, LOW, MID, PRIME.

Interpretation: LOW is the "shoulder" tier between DOWN and MID — the cells where
one schedule said M but the other said D. These are borderline hours: legal, worth
dialing if you're already at the desk, but not high-probability.

Applying that split:
- Cell is LOW if (A == D AND B == M) OR (A == M AND B == D). Never overrides PRIME.

Result:

```
      SUN  MON  TUE  WED  THU  FRI  SAT
6A    X    X    X    X    X    X    X
7A    X    X    X    X    X    X    X
8A    M    M    P    P    P    M    P
9A    M    L    P    P    P    M    P
10A   M    L    P    P    P    M    P
11A   P    L    L    L    L    M    P
12P   P    D    D    D    D    L    L
1P    M    D    D    D    D    L    L
2P    P    M    M    M    M    P    M
3P    M    M    M    P    P    P    M
4P    M    P    P    P    P    P    P
5P    P    P    P    P    P    L    P
6P    P    P    P    P    P    M    P
7P    P    P    P    P    P    L    P
8P    X    X    X    X    X    X    X
9P    X    X    X    X    X    X    X
```

Tier UX policy:
- ILLEGAL (6A–7A, 8P–9P): HARD BLOCK. No bypass. (Fla. Stat. § 501.616.)
- DOWN: HARD-BLOCK confirmation banner ("Confirm downtime dial") — bypass allowed but
        the CTA says "the data says nobody's answering."
- LOW:  Soft confirm sheet ("This is a shoulder hour — dial anyway?"). Dismiss on OK.
- MID:  No confirm; just a MID pill on the CTA.
- PRIME: Free dial, no interruption.
