# Key to 18-upstream-verification.txt

`18-upstream-verification.txt` is the unedited output of the orchestrator's lookups on 2026-11-16.
Several blocks in it carry no label. This key says which command produced each block, in file order.

1. `lima#5665`, `lima#5543`, `lima PR#4527` lines: `gh api repos/lima-vm/lima/issues/<n>` and `.../pulls/4527` (title, state, creation date).
2. `linux c163e40af9b2 …`, `linux 76031d9536a0 …`: `gh api repos/torvalds/linux/commits/<sha>` (author date, subject).
3. Lines `1328-`…`1333-` (`ts_delta = timespec64_sub(*ts, xt); if (timespec64_compare(&tk->wall_to_monotonic, &ts_delta) > 0) { ret = -EINVAL; …`): `curl https://raw.githubusercontent.com/torvalds/linux/v6.8/kernel/time/timekeeping.c | grep -n -B2 -A3 "wall_to_monotonic, &ts_delta"`. The enclosing function name is not in the snippet; the orchestrator did not capture it.
4. `x86-only select:` followed by an empty result and then `0`: `grep CLOCKSOURCE_VALIDATE_LAST_CYCLE` on v6.8 `arch/x86/Kconfig` (no match printed) and a match count on v6.8 `arch/arm64/Kconfig` (0). This does NOT establish which architectures select the option; treat that question as unverified.
5. The first `static inline u64 clocksource_delta(u64 now, u64 last, u64 mask, u64 max_delta)` block (lines numbered 33–45): `curl …/torvalds/linux/v6.13/kernel/time/timekeeping_internal.h | grep -n -A12 "static inline u64 clocksource_delta"`.
6. Block headed `--- v6.8 kernel/time/timekeeping_internal.h`: the same file at tag v6.8, showing the guarded variant under `#ifdef CONFIG_CLOCKSOURCE_VALIDATE_LAST_CYCLE` and the unguarded `return (now - last) & mask;` otherwise.
7. `--- v6.8 Kconfig selects` with `x86: 0`, `arm64: 0`: match counts in the two arch Kconfig files (same caveat as 4).
8. A bare `0` after that: `grep -c VALIDATE_LAST_CYCLE /boot/config-$(uname -r)` on the guest while it ran 6.8.0-117-generic (count 0; the following `grep` printed nothing). Re-captured with labels in `29-guest-kernel-config-check.txt`.
9. Block headed `--- v7.0 kernel/time/timekeeping_internal.h clocksource_delta`: the same function at tag v7.0.
