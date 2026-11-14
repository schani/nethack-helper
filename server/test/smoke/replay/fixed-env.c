/*
 * LD_PRELOAD shim that makes a NetHack run reproducible (test use only):
 *  - the RNG seed source (/dev/urandom, /dev/random) yields bytes derived
 *    from $NH_FIXED_SEED instead of entropy (every open gets the next block,
 *    so reseeding stays deterministic too);
 *  - time() returns $NH_FIXED_TIME (moon phase, Friday 13th, night/midnight
 *    luck and birthday all fixed).
 * Combined with `setarch -R` (no ASLR: Lua's math.random seeds from an
 * address), two runs fed the same keystrokes play the same game.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static unsigned long long counter = 0;

static FILE *
seeded_stream(void)
{
    const char *s = getenv("NH_FIXED_SEED");
    unsigned long long seed = s ? strtoull(s, 0, 0) : 42ULL;
    unsigned long long *blk = malloc(64);
    int i;

    if (!blk)
        return 0;
    for (i = 0; i < 8; i++) /* splitmix64 */
    {
        unsigned long long z = (seed += 0x9E3779B97F4A7C15ULL) + counter * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        blk[i] = z ^ (z >> 31);
    }
    counter++;
    return fmemopen(blk, 64, "r");
}

static int
is_random_dev(const char *path)
{
    return path && (!strcmp(path, "/dev/urandom") || !strcmp(path, "/dev/random"));
}

FILE *
fopen(const char *path, const char *mode)
{
    static FILE *(*real)(const char *, const char *);

    if (is_random_dev(path))
        return seeded_stream();
    if (!real)
        real = (FILE * (*)(const char *, const char *)) dlsym(RTLD_NEXT, "fopen");
    return real(path, mode);
}

FILE *
fopen64(const char *path, const char *mode)
{
    static FILE *(*real)(const char *, const char *);

    if (is_random_dev(path))
        return seeded_stream();
    if (!real)
        real = (FILE * (*)(const char *, const char *)) dlsym(RTLD_NEXT, "fopen64");
    return real(path, mode);
}

time_t
time(time_t *t)
{
    const char *s = getenv("NH_FIXED_TIME");
    time_t v = (time_t) (s ? strtoll(s, 0, 0) : 1700000000LL);

    if (t)
        *t = v;
    return v;
}
