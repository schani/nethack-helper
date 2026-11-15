/*
 * LD_PRELOAD shim for capturing eval fixtures (test use only): the sysconf
 * path is compiled into the nethack binary, so to allow debug (wizard) mode
 * in a throw-away playground, opening ".../sysconf" is redirected to
 * $NH_SYSCONF (a copy with WIZARDS=*).  Used together with the replay
 * harness's fixed-env shim (server/test/smoke/replay/fixed-env.c).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *
redirect(const char *path)
{
    const char *s = getenv("NH_SYSCONF");
    size_t n = path ? strlen(path) : 0;

    if (s && n >= 8 && !strcmp(path + n - 8, "/sysconf"))
        return s;
    return path;
}

FILE *
fopen(const char *path, const char *mode)
{
    static FILE *(*real)(const char *, const char *);

    if (!real)
        real = (FILE * (*)(const char *, const char *)) dlsym(RTLD_NEXT, "fopen");
    return real(redirect(path), mode);
}

FILE *
fopen64(const char *path, const char *mode)
{
    static FILE *(*real)(const char *, const char *);

    if (!real)
        real = (FILE * (*)(const char *, const char *)) dlsym(RTLD_NEXT, "fopen64");
    return real(redirect(path), mode);
}
