/* nethack-web	wc_feed.c
 *
 * "+feed" window-chain processor for NetHack 5.0.
 *
 * Sits between -chainin and -chainout (enable with
 * OPTIONS=windowchain:+feed in sysconf).  Every window procedure is passed
 * through to the next link (ultimately tty) unchanged; as a side effect a
 * stream of newline-delimited JSON events describing what the player can
 * see/know is written to a Unix stream socket named by the environment
 * variable NETHACK_FEED_SOCKET (or to an already-open fd given by
 * NETHACK_FEED_FD).  If neither is set, or the connection fails, the feed
 * is silently disabled and the game plays exactly as plain tty.
 *
 * The event schema is documented in shared/feed-events.ts in the
 * nethack-web repository; keep the two in sync.
 *
 * The feed must never change the game.  Reading plain state (glyphs,
 * status fields, u.uz, ...) is harmless, but NetHack's naming and farlook
 * code is not: do_screen_description()/lookat() mark nearby objects as
 * seen up close (dknown, oc_encountered, disco[]), create and free fake
 * objects for remembered-but-gone items (mksobj -> next_ident() -> rnd(),
 * i.e. it consumes the core RNG and bumps the o_id counter), set trap
 * tseen, mimic M_AP_F_DKNOWN, cleric bknown, may "find" artifacts
 * (livelog), and doname() on inventory does the same for items picked up
 * while blind.  All such text is therefore computed in a short-lived
 * forked child (see "sandbox" below) that reports the strings back over a
 * pipe and _exit()s; the game process itself only ever reads its own
 * memory.  The child is fenced off from the file system and terminal.
 *
 * NetHack may be freely redistributed.  See license for details.
 */

#include "hack.h"
#include "dungeon.h"
#include "func_tab.h"
#ifdef TTY_GRAPHICS
#include "wintty.h"
#endif

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define FEED_SCHEMA_VERSION 4

/* ------------------------------------------------------------------ */
/* prototypes                                                          */

void feed_init_nhwindows(void *, int *, char **);
void feed_player_selection(void *);
void feed_askname(void *);
void feed_get_nh_event(void *);
void feed_exit_nhwindows(void *, const char *);
void feed_suspend_nhwindows(void *, const char *);
void feed_resume_nhwindows(void *);
winid feed_create_nhwindow(void *, int);
void feed_clear_nhwindow(void *, winid);
void feed_display_nhwindow(void *, winid, boolean);
void feed_destroy_nhwindow(void *, winid);
void feed_curs(void *, winid, int, int);
void feed_putstr(void *, winid, int, const char *);
void feed_putmixed(void *, winid, int, const char *);
void feed_display_file(void *, const char *, boolean);
void feed_start_menu(void *, winid, unsigned long);
void feed_add_menu(void *, winid, const glyph_info *, const ANY_P *, char,
                   char, int, int, const char *, unsigned int);
void feed_end_menu(void *, winid, const char *);
int feed_select_menu(void *, winid, int, MENU_ITEM_P **);
char feed_message_menu(void *, char, int, const char *);
void feed_mark_synch(void *);
void feed_wait_synch(void *);
#ifdef CLIPPING
void feed_cliparound(void *, int, int);
#endif
#ifdef POSITIONBAR
void feed_update_positionbar(void *, char *);
#endif
void feed_print_glyph(void *, winid, coordxy, coordxy, const glyph_info *,
                      const glyph_info *);
void feed_raw_print(void *, const char *);
void feed_raw_print_bold(void *, const char *);
int feed_nhgetch(void *);
int feed_nh_poskey(void *, coordxy *, coordxy *, int *);
void feed_nhbell(void *);
int feed_doprev_message(void *);
char feed_yn_function(void *, const char *, const char *, char);
void feed_getlin(void *, const char *, char *);
int feed_get_ext_cmd(void *);
void feed_number_pad(void *, int);
void feed_delay_output(void *);
#ifdef CHANGE_COLOR
void feed_change_color(void *, int, long, int);
#ifdef MACOS9
void feed_change_background(void *, int);
short feed_set_font_name(void *, winid, char *);
#endif
char *feed_get_color_string(void *);
#endif
void feed_outrip(void *, winid, int, time_t);
void feed_preference_update(void *, const char *);
char *feed_getmsghistory(void *, boolean);
void feed_putmsghistory(void *, const char *, boolean);
void feed_status_init(void *);
void feed_status_finish(void *);
void feed_status_enablefield(void *, int, const char *, const char *,
                             boolean);
void feed_status_update(void *, int, genericptr_t, int, int, int,
                        unsigned long *);
boolean feed_can_suspend(void *);
void feed_update_inventory(void *, int);
win_request_info *feed_ctrl_nhwindow(void *, winid, int, win_request_info *);

void feed_procs_init(int dir);
void *feed_procs_chain(int cmd, int n, void *me, void *nextprocs,
                       void *nextdata);

struct feed_data {
    struct chain_procs *nprocs;
    void *ndata;
    int linknum;
};

#define NEXT(tdp) ((tdp)->nprocs)

/* ------------------------------------------------------------------ */
/* output plumbing                                                     */

static int feed_fd = -1;

/* growable JSON line buffer */
static char *jb = 0;
static size_t jlen = 0, jcap = 0;

static void
jreserve(size_t extra)
{
    if (jlen + extra + 1 > jcap) {
        size_t ncap = jcap ? jcap : 4096;
        char *nb;

        while (jlen + extra + 1 > ncap)
            ncap *= 2;
        nb = (char *) realloc(jb, ncap);
        if (!nb) {
            /* out of memory: give up on the feed rather than the game */
            if (feed_fd >= 0)
                (void) close(feed_fd);
            feed_fd = -1;
            return;
        }
        jb = nb;
        jcap = ncap;
    }
}

static void
jraw(const char *s, size_t n)
{
    jreserve(n);
    if (!jb || jlen + n + 1 > jcap)
        return;
    memcpy(jb + jlen, s, n);
    jlen += n;
    jb[jlen] = '\0';
}

static void
jcat(const char *s)
{
    jraw(s, strlen(s));
}

static void
jchar(char c)
{
    jraw(&c, 1);
}

/* append a JSON string literal; bytes >= 0x80 are treated as Latin-1 so
   the output is always valid UTF-8/JSON regardless of symset */
static void
jstr(const char *s)
{
    char tmp[8];
    const unsigned char *p = (const unsigned char *) (s ? s : "");

    jchar('"');
    for (; *p; ++p) {
        unsigned char c = *p;

        if (c == '"' || c == '\\') {
            jchar('\\');
            jchar((char) c);
        } else if (c == '\n') {
            jcat("\\n");
        } else if (c == '\t') {
            jcat("\\t");
        } else if (c < 0x20 || c >= 0x7f) {
            Snprintf(tmp, sizeof tmp, "\\u%04x", (unsigned) c);
            jcat(tmp);
        } else {
            jchar((char) c);
        }
    }
    jchar('"');
}

static void
jint(long v)
{
    char tmp[32];

    Snprintf(tmp, sizeof tmp, "%ld", v);
    jcat(tmp);
}

/* "key": helpers; 'first' handling is left to the caller via leading ',' */
static void
jkey(const char *k)
{
    jstr(k);
    jchar(':');
}

static void
jkv_str(const char *k, const char *v)
{
    jchar(',');
    jkey(k);
    jstr(v);
}

static void
jkv_int(const char *k, long v)
{
    jchar(',');
    jkey(k);
    jint(v);
}

static void
jkv_bool(const char *k, boolean v)
{
    jchar(',');
    jkey(k);
    jcat(v ? "true" : "false");
}

/* begin an event object: {"t":"type","seq":N */
static unsigned long feed_seq = 0;

static pid_t feed_pid = 0; /* process that owns the feed connection */
static boolean in_event = FALSE;

static boolean
ev_begin(const char *type)
{
    if (feed_fd < 0)
        return FALSE;
    /* a forked child (e.g. the gzip helper used for save files) inherits
       the socket until exec; it must not write into the parent's stream */
    if (getpid() != feed_pid)
        return FALSE;
    /* building an event can call back into the window port (doname(),
       farlook, impossible() -> pline); drop such nested events rather
       than clobber the half-built line */
    if (in_event)
        return FALSE;
    in_event = TRUE;
    jlen = 0;
    if (jb)
        jb[0] = '\0';
    jcat("{\"t\":");
    jstr(type);
    jkv_int("seq", (long) ++feed_seq);
    return TRUE;
}

static void
ev_end(void)
{
    size_t off = 0;

    in_event = FALSE;
    if (feed_fd < 0 || !jb)
        return;
    jcat("}\n");
    while (off < jlen) {
        ssize_t w = send(feed_fd, jb + off, jlen - off, MSG_NOSIGNAL);

        if (w < 0) {
            if (errno == EINTR)
                continue;
            /* reader went away; stop feeding but keep playing */
            (void) close(feed_fd);
            feed_fd = -1;
            return;
        }
        off += (size_t) w;
    }
}

static void
feed_open(void)
{
    const char *path = getenv("NETHACK_FEED_SOCKET");
    const char *fdstr = getenv("NETHACK_FEED_FD");

    if (feed_fd >= 0)
        return;
    if (path && *path) {
        struct sockaddr_un sa;
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);

        if (fd < 0)
            return;
        memset(&sa, 0, sizeof sa);
        sa.sun_family = AF_UNIX;
        if (strlen(path) >= sizeof sa.sun_path) {
            (void) close(fd);
            return;
        }
        Strcpy(sa.sun_path, path);
        if (connect(fd, (struct sockaddr *) &sa, sizeof sa) < 0) {
            (void) close(fd);
            return;
        }
        (void) fcntl(fd, F_SETFD, FD_CLOEXEC);
        feed_fd = fd;
        feed_pid = getpid();
    } else if (fdstr && *fdstr) {
        int fd = atoi(fdstr);

        if (fd > 2 && fcntl(fd, F_GETFD) != -1) {
            (void) fcntl(fd, F_SETFD, FD_CLOEXEC);
            feed_fd = fd;
            feed_pid = getpid();
        }
    }
}

/* ------------------------------------------------------------------ */
/* sandbox: side-effect free evaluation of NetHack's text functions    */

#define FEED_SANDBOX_TIMEOUT_MS 4000

/* child side: buffered writer of NUL-terminated strings */
static int sb_wfd = -1;
static char sb_wbuf[16384];
static size_t sb_wlen = 0;

static void
sb_flushw(void)
{
    size_t off = 0;

    while (off < sb_wlen) {
        ssize_t w = write(sb_wfd, sb_wbuf + off, sb_wlen - off);

        if (w < 0) {
            if (errno == EINTR)
                continue;
            _exit(3);
        }
        off += (size_t) w;
    }
    sb_wlen = 0;
}

static void
sb_put(const char *s)
{
    size_t n = strlen(s ? s : "") + 1;

    if (sb_wlen + n > sizeof sb_wbuf)
        sb_flushw();
    if (n > sizeof sb_wbuf) /* can't happen for BUFSZ strings */
        n = sizeof sb_wbuf, s = "";
    memcpy(sb_wbuf + sb_wlen, s ? s : "", n);
    sb_wlen += n;
}

/* Make the forked child harmless: whatever the description code does in
   there (including impossible()/panic() paths) must not reach the
   terminal, the playground files, the feed socket or other processes. */
static void
sandbox_child_init(int wfd)
{
    static const int dflsigs[] = {
        SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGSEGV, SIGBUS, SIGFPE,
        SIGILL, SIGABRT, SIGPIPE, SIGALRM, SIGUSR1, SIGUSR2,
    };
    struct rlimit zero;
    int i, nul, inp[2];

    for (i = 0; i < SIZE(dflsigs); i++)
        (void) signal(dflsigs[i], SIG_DFL);
    (void) signal(SIGXFSZ, SIG_IGN); /* file writes fail instead */
    (void) alarm(FEED_SANDBOX_TIMEOUT_MS / 1000 + 1); /* backstop */
    zero.rlim_cur = zero.rlim_max = 0;
    (void) setrlimit(RLIMIT_FSIZE, &zero); /* no file data */
    (void) setrlimit(RLIMIT_NPROC, &zero); /* no helper processes */
    (void) setrlimit(RLIMIT_CORE, &zero);
    /* relative paths (save/, lock files, logs) resolve somewhere
       nothing can be created */
    if (chdir("/proc") < 0)
        (void) chdir("/");
    /* terminal: output discarded; input blocks forever (never EOF, which
       NetHack would treat as a hangup and try to save) */
    nul = open("/dev/null", O_RDWR);
    if (pipe(inp) == 0)
        (void) dup2(inp[0], 0);
    if (nul >= 0) {
        (void) dup2(nul, 1);
        (void) dup2(nul, 2);
    }
    if (feed_fd >= 0)
        (void) close(feed_fd);
    feed_fd = -1;
    sb_wfd = wfd;
    sb_wlen = 0;
    /* belt and braces for the paths above */
    program_state.panicking = 1;   /* panic() -> abort() right away */
    program_state.in_paniclog = 1; /* no paniclog writes */
    sysopt.livelog = 0L;
    sysopt.crashreporturl = (char *) 0;
}

/* Capture mode (sandbox child only): the child runs whole player commands
   (dodiscovered() for '\\', show_overview() for ^O) and the window procs
   below hand their text to sb_put() instead of tty, and never block for
   input.  Window ids handed out in this mode are fake. */
static boolean sb_capture = FALSE;
#define FEED_CAPWIN 990
#define CAPWIN(w) (sb_capture && (w) == FEED_CAPWIN)

/* parent side: collected output of the last sandbox run */
static char *sb_data = 0;
static size_t sb_len = 0, sb_cap = 0, sb_pos = 0;
static unsigned long feed_sandbox_runs = 0, feed_sandbox_failures = 0;

static long
mono_ms(void)
{
    struct timespec ts;

    (void) clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long) ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* Run fn(arg) in a forked child; its sb_put() strings become available
   through sb_next().  Returns FALSE if the child failed (sb_next() then
   yields whatever arrived completely, followed by ""). */
static boolean
sandbox_run(void (*fn)(genericptr_t), genericptr_t arg)
{
    int pfd[2], status = 0;
    pid_t pid;
    long deadline;
    boolean ok = TRUE, eof = FALSE;

    sb_len = sb_pos = 0;
    ++feed_sandbox_runs;
    if (pipe(pfd) < 0) {
        ++feed_sandbox_failures;
        return FALSE;
    }
    pid = fork();
    if (pid < 0) {
        (void) close(pfd[0]);
        (void) close(pfd[1]);
        ++feed_sandbox_failures;
        return FALSE;
    }
    if (pid == 0) {
        (void) close(pfd[0]);
        sandbox_child_init(pfd[1]);
        (*fn)(arg);
        sb_flushw();
        _exit(0);
    }
    (void) close(pfd[1]);
    deadline = mono_ms() + FEED_SANDBOX_TIMEOUT_MS;
    while (!eof) {
        struct pollfd pf;
        long left = deadline - mono_ms();
        int r;
        ssize_t k;

        if (left <= 0) {
            ok = FALSE;
            break;
        }
        pf.fd = pfd[0], pf.events = POLLIN, pf.revents = 0;
        r = poll(&pf, 1, (int) left);
        if (r < 0 && errno != EINTR) {
            ok = FALSE;
            break;
        }
        if (r <= 0)
            continue;
        if (sb_cap - sb_len < 65536) {
            size_t ncap = sb_cap ? sb_cap * 2 : 262144;
            char *nb = (char *) realloc(sb_data, ncap);

            if (!nb) {
                ok = FALSE;
                break;
            }
            sb_data = nb, sb_cap = ncap;
        }
        k = read(pfd[0], sb_data + sb_len, sb_cap - sb_len - 1);
        if (k < 0) {
            if (errno == EINTR || errno == EAGAIN)
                continue;
            ok = FALSE;
            break;
        }
        if (k == 0)
            eof = TRUE;
        sb_len += (size_t) k;
    }
    (void) close(pfd[0]);
    if (!eof)
        (void) kill(pid, SIGKILL);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
        continue;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
        ok = FALSE;
    /* only trust complete (NUL-terminated) strings */
    while (sb_len > 0 && sb_data[sb_len - 1] != '\0')
        --sb_len;
    if (!ok)
        ++feed_sandbox_failures;
    return ok;
}

/* next string produced by the last sandbox run ("" once exhausted) */
static const char *
sb_next(void)
{
    const char *s;

    if (!sb_data || sb_pos >= sb_len)
        return "";
    s = sb_data + sb_pos;
    sb_pos += strlen(s) + 1;
    return s;
}

/* ------------------------------------------------------------------ */
/* tracked state                                                       */

#define FEED_MAXWIN 64
static int wintypes[FEED_MAXWIN]; /* NHW_xxx, 0 = unknown */

/* buffered text lines for NHW_TEXT / NHW_MENU windows used as text */
struct feed_lines {
    char **ln;
    int n, cap;
};
static struct feed_lines wintext[FEED_MAXWIN];

/* menu under construction per window */
struct feed_menuitem {
    char ch, gch;
    char shown; /* selector actually displayed (core's or tty-assigned) */
    int page;   /* 1-based tty menu page, 0 = unknown */
    int attr, clr;
    boolean selectable, preselected;
    char *text;
};
struct feed_menu {
    struct feed_menuitem *items;
    int n, cap;
    char *prompt;
    unsigned long mbehavior;
};
static struct feed_menu winmenu[FEED_MAXWIN];

/* map cells as last printed (map coordinates) */
struct feed_cell {
    int glyph, ttychar, color;
    unsigned glyphflags;
    boolean dirty;
};
static struct feed_cell cells[COLNO][ROWNO];
static boolean map_dirty = FALSE;

static boolean inv_dirty = TRUE;

/* level last announced */
static d_level last_lev = { -1, -1 };

/* status fields */
#define FEED_STATVAL 256
static char statvals[MAXBLSTATS][FEED_STATVAL];
static boolean statvalid[MAXBLSTATS];
static int statcolor[MAXBLSTATS];
static long statcond = 0L;
static char *last_status_json = 0;

static const char *const statkeys[MAXBLSTATS] = {
    "title",     "str",   "dex",     "con",       "int",
    "wis",       "cha",   "align",   "score",     "encumbrance",
    "gold",      "power", "power_max", "xp_level", "ac",
    "hit_dice",  "time",  "hunger",  "hp",        "hp_max",
    "level_desc", "exp_points", "condition", "weapon", "armor",
    "terrain",   "version",
};

static boolean
valid_win(winid w)
{
    return (w >= 0 && w < FEED_MAXWIN);
}

static void
lines_clear(struct feed_lines *fl)
{
    int i;

    for (i = 0; i < fl->n; i++)
        free(fl->ln[i]);
    fl->n = 0;
}

static void
lines_add(struct feed_lines *fl, const char *s)
{
    if (fl->n >= fl->cap) {
        int ncap = fl->cap ? fl->cap * 2 : 32;
        char **nl = (char **) realloc(fl->ln, ncap * sizeof(char *));

        if (!nl)
            return;
        fl->ln = nl;
        fl->cap = ncap;
    }
    fl->ln[fl->n++] = dupstr(s ? s : "");
}

static void
menu_clear(struct feed_menu *m)
{
    int i;

    for (i = 0; i < m->n; i++)
        free(m->items[i].text);
    m->n = 0;
    if (m->prompt)
        free(m->prompt), m->prompt = 0;
}

/* ------------------------------------------------------------------ */
/* event emitters                                                      */

static boolean
level_valid(void)
{
    return (u.uz.dlevel > 0 && u.uz.dnum >= 0
            && u.uz.dnum < svn.n_dgns
            && (program_state.in_moveloop || program_state.gameover));
}

static mapseen *
feed_find_mapseen(d_level *lev)
{
    mapseen *m;

    for (m = svm.mapseenchn; m; m = m->next)
        if (on_level(&m->lev, lev))
            return m;
    return (mapseen *) 0;
}

static void
emit_level(void)
{
    char buf[BUFSZ];
    mapseen *ms;

    if (!ev_begin("level"))
        return;
    jkv_int("dnum", (long) u.uz.dnum);
    jkv_int("dlevel", (long) u.uz.dlevel);
    jkv_int("depth", (long) depth(&u.uz));
    jkv_str("dungeon", svd.dungeons[u.uz.dnum].dname);
    buf[0] = '\0';
    (void) describe_level(buf, 0);
    jkv_str("desc", trimspaces(buf));
    buf[0] = '\0';
    (void) describe_level(buf, 2);
    jkv_str("long_desc", buf);
    ms = feed_find_mapseen(&u.uz);
    jchar(',');
    jkey("known");
    jchar('[');
    if (ms) {
        boolean first = TRUE;
#define KNOWN(cond, name) \
    if (cond) {                    \
        if (!first)                \
            jchar(',');            \
        jstr(name);                \
        first = FALSE;             \
    }
        KNOWN(ms->flags.oracle, "oracle");
        KNOWN(ms->flags.bigroom, "bigroom");
        KNOWN(ms->flags.castle, "castle");
        KNOWN(ms->flags.valley, "valley");
        KNOWN(ms->flags.msanctum, "sanctum");
        KNOWN(ms->flags.ludios, "ludios");
        KNOWN(ms->flags.roguelevel, "roguelevel");
        KNOWN(ms->flags.sokosolved, "sokoban_solved");
        KNOWN(ms->flags.knownbones, "bones");
        KNOWN(ms->flags.vibrating_square, "vibrating_square");
#undef KNOWN
    }
    jchar(']');
    if (ms && ms->custom)
        jkv_str("annotation", ms->custom);
    ev_end();
    last_lev = u.uz;
}

/* new game vs restored save, decided while the game starts up: both
   newgame() and dorecover() redraw the map (docrt -> cls ->
   clear_nhwindow(WIN_MAP)) before the move loop starts; dorecover()
   sets beyond_savefile_load first, newgame() doesn't (moveloop does). */
enum { ORIGIN_UNKNOWN = 0, ORIGIN_NEW, ORIGIN_RESTORED };
static int game_origin = ORIGIN_UNKNOWN;
static boolean game_sent = FALSE;

static void
note_origin(winid window)
{
    if (program_state.in_moveloop || game_sent)
        return;
    if (program_state.restoring)
        game_origin = ORIGIN_RESTORED;
    else if (window == WIN_MAP && window != WIN_ERR)
        game_origin = program_state.beyond_savefile_load ? ORIGIN_RESTORED
                                                         : ORIGIN_NEW;
}

/* identity of the game being played; sent once, before the first level */
static void
emit_game(void)
{
    const char *role;

    if (!ev_begin("game"))
        return;
    game_sent = TRUE;
    jkv_str("origin", game_origin == ORIGIN_NEW ? "new"
                      : game_origin == ORIGIN_RESTORED ? "restored"
                        : "unknown");
    jkv_str("name", svp.plname);
    jkv_int("birthday", (long) ubirthday);
    jkv_str("uuid", svn.nhuuid);
    role = (flags.female && gu.urole.name.f) ? gu.urole.name.f
                                              : gu.urole.name.m;
    jkv_str("role", role);
    jkv_str("race", gu.urace.noun);
    jkv_str("gender", genders[flags.female ? 1 : 0].adj);
    jkv_str("alignment", (flags.initalign >= 0 && flags.initalign < 3)
                             ? aligns[flags.initalign].adj : "");
    jkv_str("mode", wizard ? "debug" : discover ? "explore" : "normal");
    jkv_int("turn", svm.moves);
    ev_end();
}

static void
check_level(void)
{
    if (feed_fd < 0 || !level_valid())
        return;
    if (!game_sent)
        emit_game();
    if (!on_level(&last_lev, &u.uz))
        emit_level();
}

/* describe a map location the way farlook (';') would, based solely on
   the glyph currently displayed/remembered there */
static void
describe_cell(coordxy x, coordxy y, char *shortbuf, char *longbuf)
{
    coord cc;
    char out_str[BUFSZ], decoded[BUFSZ];
    const char *firstmatch = "";
    const char *p;
    int found;

    shortbuf[0] = longbuf[0] = '\0';
    cc.x = x, cc.y = y;
    out_str[0] = '\0';
    found = do_screen_description(cc, TRUE, 0, out_str, &firstmatch,
                                  (struct permonst **) 0);
    if (!found)
        return;
    if (firstmatch)
        Strcpy(shortbuf, firstmatch);
    (void) decode_mixed(decoded, out_str);
    /* drop the leading "<sym>        " prefix that farlook shows */
    p = decoded;
    if (*p)
        ++p;
    while (*p == ' ')
        ++p;
    Strcpy(longbuf, p);
}

/* work for one sandbox run: which texts the next map/inventory events need */
static size_t sb_inv_pos = 0;
static struct {
    int ncells;
    coordxy x[COLNO * ROWNO], y[COLNO * ROWNO];
    boolean inv;
    boolean extras; /* discoveries, overview, underfoot */
} sbjob;

/* separators in the sandbox output of the extras */
#define SB_END_BLOCK "\036"

/* describe the remembered glyph under the hero (what the map shows there
   once the hero steps off; ':' look tells the player the same) */
static void
describe_underfoot(void)
{
    char sbuf[BUFSZ], lbuf[BUFSZ], chbuf[2], clrbuf[16];
    int glyph = levl[u.ux][u.uy].glyph;
    glyph_info ginfo;

    sbuf[0] = lbuf[0] = '\0';
    chbuf[0] = ' ', chbuf[1] = '\0';
    Strcpy(clrbuf, "8");
    if (!glyph_is_unexplored(glyph) && glyph != cmap_to_glyph(S_stone)) {
        coordxy x = u.ux, y = u.uy;

        map_glyphinfo(x, y, glyph, 0, &ginfo);
        chbuf[0] = (char) (ginfo.ttychar ? ginfo.ttychar : ' ');
        Sprintf(clrbuf, "%d", (int) ginfo.gm.sym.color);
        /* this is a throw-away child: show the remembered glyph and move
           the hero off the map so farlook describes the glyph, not "you" */
        gg.gbuf[y][x].glyphinfo.glyph = glyph;
        u.ux = 0;
        describe_cell(x, y, sbuf, lbuf);
        u.ux = x;
    }
    sb_put(chbuf);
    sb_put(clrbuf);
    sb_put(sbuf);
    sb_put(lbuf);
}

/* runs in the sandbox child */
static void
sandbox_texts(genericptr_t arg)
{
    char sbuf[BUFSZ], lbuf[BUFSZ];
    struct obj *otmp;
    int i;

    nhUse(arg);
    for (i = 0; i < sbjob.ncells; i++) {
        describe_cell(sbjob.x[i], sbjob.y[i], sbuf, lbuf);
        sb_put(sbuf);
        sb_put(lbuf);
    }
    if (sbjob.inv)
        for (otmp = gi.invent; otmp; otmp = otmp->nobj)
            sb_put(doname(otmp));
    if (sbjob.extras) {
        /* underfoot first: the commands below may change the display */
        describe_underfoot();
        sb_capture = TRUE;
        iflags.menu_requested = FALSE;
        (void) dodiscovered();
        sb_put(SB_END_BLOCK);
        show_overview(0, 0);
        sb_put(SB_END_BLOCK);
        sb_capture = FALSE;
    }
}

static boolean
map_pending(void)
{
    return (map_dirty && feed_fd >= 0 && level_valid());
}

static boolean
inv_pending(void)
{
    return (inv_dirty && feed_fd >= 0
            && (program_state.in_moveloop || program_state.gameover));
}

static boolean
cell_needs_text(struct feed_cell *c)
{
    return !glyph_is_unexplored(c->glyph);
}

/* extras (discoveries, overview, underfoot) last computed for ... */
static unsigned long extras_disco_sig = 0;
static d_level extras_lev = { -1, -1 };
static coordxy extras_ux = -1, extras_uy = -1;
static int extras_under_glyph = -1;
/* ... and last sent (only changes are emitted) */
static char *sent_disco = 0, *sent_overview = 0, *sent_underfoot = 0;
static boolean extras_ok = FALSE;
static size_t sb_extras_pos = 0;

/* cheap fingerprint of the player's object knowledge (read-only) */
static unsigned long
disco_signature(void)
{
    unsigned long h = 5381UL;
    const char *p;
    int i;

    for (i = 0; i < NUM_OBJECTS; i++) {
        h = h * 33UL + (unsigned long) svd.disco[i];
        h = h * 33UL + (unsigned long) (objects[i].oc_name_known
                                        | (objects[i].oc_encountered << 1));
        if ((p = objects[i].oc_uname) != 0)
            while (*p)
                h = h * 33UL + (unsigned char) *p++;
    }
    return h;
}

static boolean
extras_possible(void)
{
    return (feed_fd >= 0 && level_valid() && program_state.in_moveloop
            && !program_state.gameover && isok(u.ux, u.uy));
}

/* something the extras depend on changed since they were last computed? */
static boolean
extras_stale(void)
{
    if (!extras_possible())
        return FALSE;
    return (!on_level(&extras_lev, &u.uz) || u.ux != extras_ux
            || u.uy != extras_uy
            || levl[u.ux][u.uy].glyph != extras_under_glyph
            || disco_signature() != extras_disco_sig);
}

/* compute every text the pending map/inventory events need, in one
   sandboxed child */
static void
prepare_texts(void)
{
    coordxy x, y;
    int i;
    boolean ok = TRUE;
    struct obj *otmp;

    sbjob.ncells = 0;
    sbjob.inv = inv_pending();
    if (map_pending())
        for (y = 0; y < ROWNO; y++)
            for (x = 0; x < COLNO; x++)
                if (cells[x][y].dirty && cell_needs_text(&cells[x][y])) {
                    sbjob.x[sbjob.ncells] = x;
                    sbjob.y[sbjob.ncells] = y;
                    sbjob.ncells++;
                }
    /* the extras ride along whenever the child runs anyway, and force a
       run when something they depend on changed */
    sbjob.extras = extras_possible()
                   && (sbjob.ncells || sbjob.inv || extras_stale());
    sb_len = sb_pos = 0;
    if (sbjob.ncells || (sbjob.inv && gi.invent) || sbjob.extras)
        ok = sandbox_run(sandbox_texts, (genericptr_t) 0);
    /* inventory texts follow the two strings per described cell */
    for (i = 0; i < 2 * sbjob.ncells; i++)
        (void) sb_next();
    sb_inv_pos = sb_pos;
    /* then the extras */
    if (sbjob.inv)
        for (otmp = gi.invent; otmp; otmp = otmp->nobj)
            (void) sb_next();
    sb_extras_pos = sb_pos;
    extras_ok = sbjob.extras && ok;
    if (sbjob.extras) {
        /* remember what they were computed for even if the child failed,
           so a failing child is not re-run on every keystroke */
        extras_disco_sig = disco_signature();
        extras_lev = u.uz;
        extras_ux = u.ux, extras_uy = u.uy;
        extras_under_glyph = levl[u.ux][u.uy].glyph;
    }
    sb_pos = 0;
}

static void
emit_map(void)
{
    coordxy x, y;
    boolean first = TRUE;
    char chbuf[2];

    if (!map_pending())
        return;
    if (!ev_begin("map"))
        return;
    jkv_int("dnum", (long) u.uz.dnum);
    jkv_int("dlevel", (long) u.uz.dlevel);
    jchar(',');
    jkey("cells");
    jchar('[');
    /* same order as prepare_texts() */
    for (y = 0; y < ROWNO; y++) {
        for (x = 0; x < COLNO; x++) {
            struct feed_cell *c = &cells[x][y];

            if (!c->dirty)
                continue;
            c->dirty = FALSE;
            if (!first)
                jchar(',');
            first = FALSE;
            jcat("{\"x\":");
            jint((long) x);
            jkv_int("y", (long) y);
            jkv_int("glyph", (long) c->glyph);
            chbuf[0] = (char) (c->ttychar ? c->ttychar : ' ');
            chbuf[1] = '\0';
            jkv_str("ch", chbuf);
            jkv_int("color", (long) c->color);
            if (c->glyphflags)
                jkv_int("flags", (long) c->glyphflags);
            if (cell_needs_text(c)) {
                jkv_str("desc", sb_next());
                jkv_str("look", sb_next());
            } else {
                jkv_str("desc", "unexplored area");
                jkv_str("look", "unexplored area");
            }
            jchar('}');
        }
    }
    jchar(']');
    jkv_int("ux", (long) u.ux);
    jkv_int("uy", (long) u.uy);
    ev_end();
    map_dirty = FALSE;
}

static void
emit_inventory(void)
{
    struct obj *otmp;
    boolean first = TRUE;
    char letter[2];

    if (!inv_pending())
        return;
    inv_dirty = FALSE;
    sb_pos = sb_inv_pos;
    if (!ev_begin("inventory"))
        return;
    jchar(',');
    jkey("items");
    jchar('[');
    for (otmp = gi.invent; otmp; otmp = otmp->nobj) {
        long wm = otmp->owornmask;

        if (!first)
            jchar(',');
        first = FALSE;
        letter[0] = otmp->invlet;
        letter[1] = '\0';
        jcat("{\"letter\":");
        jstr(letter);
        jkv_str("text", sb_next()); /* doname(), from prepare_texts() */
        letter[0] = def_oc_syms[(int) otmp->oclass].sym;
        jkv_str("class_sym", letter);
        jkv_str("class", def_oc_syms[(int) otmp->oclass].name);
        jkv_int("quan", otmp->quan);
        jchar(',');
        jkey("slots");
        jchar('[');
        {
            boolean f2 = TRUE;
#define SLOT(mask, name) \
    if (wm & (mask)) {             \
        if (!f2)                   \
            jchar(',');            \
        jstr(name);                \
        f2 = FALSE;                \
    }
            SLOT(W_WEP, u.twoweap ? "wielded_primary" : "wielded");
            SLOT(W_SWAPWEP, u.twoweap ? "wielded_secondary" : "alternate");
            SLOT(W_QUIVER, "quiver");
            SLOT(W_ARM, "body_armor");
            SLOT(W_ARMC, "cloak");
            SLOT(W_ARMH, "helmet");
            SLOT(W_ARMS, "shield");
            SLOT(W_ARMG, "gloves");
            SLOT(W_ARMF, "boots");
            SLOT(W_ARMU, "shirt");
            SLOT(W_AMUL, "amulet");
            SLOT(W_RINGL, "left_ring");
            SLOT(W_RINGR, "right_ring");
            SLOT(W_TOOL, "eyewear");
            SLOT(W_SADDLE, "saddle");
            SLOT(W_BALL, "ball");
            SLOT(W_CHAIN, "chain");
#undef SLOT
        }
        jchar(']');
        jkv_bool("worn", (wm & (W_ARMOR | W_ACCESSORY)) != 0);
        jkv_bool("wielded", (wm & W_WEP) != 0
                                || (u.twoweap && (wm & W_SWAPWEP) != 0));
        jchar('}');
    }
    jchar(']');
    ev_end();
}

static void
emit_status(void)
{
    int i;
    boolean first = TRUE;

    if (!ev_begin("status"))
        return;
    jchar(',');
    jkey("fields");
    jchar('{');
    for (i = 0; i < MAXBLSTATS; i++) {
        if (!statvalid[i] || i == BL_CONDITION)
            continue;
        if (!first)
            jchar(',');
        first = FALSE;
        jkey(statkeys[i]);
        jstr(statvals[i]);
    }
    jchar('}');
    jchar(',');
    jkey("conditions");
    jchar('[');
    first = TRUE;
    for (i = 0; i < CONDITION_COUNT; i++) {
        if (statcond & conditions[i].mask) {
            if (!first)
                jchar(',');
            first = FALSE;
            jstr(conditions[i].text[0]);
        }
    }
    jchar(']');
    jkv_int("turn", svm.moves);
    /* suppress duplicates: compare everything after the seq number */
    {
        const char *body = strstr(jb ? jb : "", ",\"fields\"");

        if (body && last_status_json && !strcmp(body, last_status_json)) {
            --feed_seq;
            in_event = FALSE;
            return; /* identical to the last one sent */
        }
        if (body) {
            free(last_status_json);
            last_status_json = dupstr(body);
        }
    }
    ev_end();
}

/* collect sandbox strings up to the next SB_END_BLOCK into one
   newline-joined string (caller frees) */
static char *
sb_block(void)
{
    size_t len = 0, cap = 256;
    char *buf = (char *) malloc(cap);
    const char *s;

    if (!buf)
        return dupstr("");
    buf[0] = '\0';
    while (sb_pos < sb_len && strcmp(s = sb_next(), SB_END_BLOCK)) {
        size_t n = strlen(s);

        if (len + n + 2 > cap) {
            while (len + n + 2 > cap)
                cap *= 2;
            {
                char *nb = (char *) realloc(buf, cap);

                if (!nb)
                    break;
                buf = nb;
            }
        }
        if (len)
            buf[len++] = '\n';
        memcpy(buf + len, s, n);
        len += n;
        buf[len] = '\0';
    }
    return buf;
}

/* emit "lines" of a newline-joined block */
static void
jkv_lines(const char *k, const char *block)
{
    const char *p = block, *nl;
    boolean first = TRUE;
    char line[BUFSZ];

    jchar(',');
    jkey(k);
    jchar('[');
    while (*block && p) {
        size_t n;

        nl = strchr(p, '\n');
        n = nl ? (size_t) (nl - p) : strlen(p);
        if (n >= sizeof line)
            n = sizeof line - 1;
        memcpy(line, p, n);
        line[n] = '\0';
        if (!first)
            jchar(',');
        first = FALSE;
        jstr(line);
        p = nl ? nl + 1 : 0;
    }
    jchar(']');
}

/* 'discoveries', 'overview' and 'underfoot' events, when they changed */
static void
emit_extras(void)
{
    char *disco, *overview, under[3 * BUFSZ];
    const char *ch, *clr, *desc, *look;

    if (!extras_ok)
        return;
    extras_ok = FALSE;
    sb_pos = sb_extras_pos;
    ch = sb_next();
    clr = sb_next();
    desc = sb_next();
    look = sb_next();
    Snprintf(under, sizeof under, "%d,%d,%d,%s\001%s\001%s\001%s",
             (int) u.ux, (int) u.uy, extras_under_glyph, ch, clr, desc,
             look);
    if (!sent_underfoot || strcmp(sent_underfoot, under)) {
        if (ev_begin("underfoot")) {
            jkv_int("x", (long) u.ux);
            jkv_int("y", (long) u.uy);
            jkv_int("glyph", (long) extras_under_glyph);
            jkv_str("ch", ch);
            jkv_int("color", atol(clr));
            jkv_str("desc", desc);
            jkv_str("look", look);
            ev_end();
        }
        free(sent_underfoot);
        sent_underfoot = dupstr(under);
    }
    disco = sb_block();
    overview = sb_block();
    if (!sent_disco || strcmp(sent_disco, disco)) {
        if (ev_begin("discoveries")) {
            jkv_lines("lines", disco);
            ev_end();
        }
        free(sent_disco);
        sent_disco = disco;
    } else {
        free(disco);
    }
    /* an empty overview means the child could not produce one */
    if (*overview && (!sent_overview || strcmp(sent_overview, overview))) {
        if (ev_begin("overview")) {
            jkv_lines("lines", overview);
            ev_end();
        }
        free(sent_overview);
        sent_overview = overview;
    } else {
        free(overview);
    }
}

/* ------------------------------------------------------------------ */
/* key bindings                                                        */

/* The command keys as currently bound (default table, number_pad and its
   modes, BIND= lines, rest_on_space), read straight from gc.Cmd: the same
   table rhack()/parse() dispatch on and dokeylist() ('?' "Full list of
   keyboard commands") prints.  Plain memory reads, no side effects, so
   this runs in the game process.  Sent when anything in it changes. */

/* special (non-command) keys worth telling the player about; the key
   itself always comes from gc.Cmd.spkeys[] */
static const struct {
    int nhkf;
    const char *name, *desc;
    boolean numpad_only;
} feed_spkeys[] = {
    { NHKF_ESC, "escape", "cancel the current prompt or a pending prefix",
      FALSE },
    { NHKF_COUNT, "count",
      "prefix: type a count before a command (e.g. n20s searches 20 times)",
      TRUE },
    { NHKF_GETDIR_SELF, "getdir.self",
      "at an 'In what direction?' prompt: yourself / here", FALSE },
    { NHKF_GETDIR_SELF2, "getdir.self2",
      "at an 'In what direction?' prompt: yourself / here", FALSE },
    { NHKF_GETPOS_SELF, "getpos.self",
      "when picking a map position: move the cursor onto yourself", FALSE },
    { NHKF_GETPOS_PICK, "getpos.pick",
      "when picking a map position: select the spot under the cursor",
      FALSE },
    { NHKF_GETPOS_PICK_Q, "getpos.pick.quick",
      "when picking a map position: select it (brief description)", FALSE },
    { NHKF_GETPOS_PICK_V, "getpos.pick.verbose",
      "when picking a map position: select it (full description)", FALSE },
    { NHKF_GETPOS_MON_NEXT, "getpos.mon.next",
      "when picking a map position: jump the cursor to the next monster",
      FALSE },
    { NHKF_GETPOS_OBJ_NEXT, "getpos.obj.next",
      "when picking a map position: jump the cursor to the next object",
      FALSE },
    { NHKF_GETPOS_DOOR_NEXT, "getpos.door.next",
      "when picking a map position: jump the cursor to the next door",
      FALSE },
    { NHKF_GETPOS_INTERESTING_NEXT, "getpos.all.next",
      "when picking a map position: jump the cursor to the next interesting "
      "thing", FALSE },
    { NHKF_GETPOS_HELP, "getpos.help",
      "when picking a map position: help on the cursor keys", FALSE },
};

static unsigned long sent_keys_sig = 0;
static boolean sent_keys = FALSE;

static boolean
keybind_usable(const struct Cmd_bind *b)
{
    uchar k = b->key;

    if (!k || !b->cmd || !b->cmd->ef_txt)
        return FALSE;
    /* without number_pad, parse() reads leading digits as a count before
       it looks at the binding table */
    if (!gc.Cmd.num_pad && k >= '0' && k <= '9')
        return FALSE;
    if ((b->cmd->flags & INTERNALCMD) != 0)
        return FALSE;
    return TRUE;
}

static unsigned long
keys_signature(void)
{
    unsigned long h = 5381UL;
    const struct Cmd_bind *b;
    const char *p;
    int i;

    for (b = gc.Cmd.cmdbinds; b; b = b->next) {
        h = h * 33UL + (unsigned long) b->key;
        h = h * 33UL + (unsigned long) (size_t) b->cmd;
        if ((p = b->param) != 0)
            while (*p)
                h = h * 33UL + (unsigned char) *p++;
    }
    for (i = 0; i < NUM_NHKF; i++)
        h = h * 33UL + (unsigned char) gc.Cmd.spkeys[i];
    h = h * 33UL + (unsigned long) gc.Cmd.num_pad;
    h = h * 33UL + (unsigned long) iflags.num_pad_mode;
    h = h * 33UL + (unsigned long) flags.rest_on_space;
    h = h * 33UL + (unsigned long) wizard;
    if ((p = gc.Cmd.dirchars) != 0)
        while (*p)
            h = h * 33UL + (unsigned char) *p++;
    return h;
}

static const char *
keycmd_kind(unsigned flgs)
{
    return (flgs & WIZMODECMD) ? "debug"
           : (flgs & MOVEMENTCMD) ? "move"
           : (flgs & PREFIXCMD) ? "prefix"
           : (flgs & GENERALCMD) ? "general"
           : "game";
}

/* one entry of "commands"; keys bound with a parameter (BIND=k:cmd:param)
   are separate entries with "param" */
static void
emit_keycmd(const struct ext_func_tab *ec, const char *param, int onlykey)
{
    const struct Cmd_bind *b;
    boolean first = TRUE;

    jchar('{');
    jkey("name");
    jstr(ec->ef_txt);
    jkv_str("desc", ec->ef_desc ? ec->ef_desc : "");
    jkv_str("kind", keycmd_kind(ec->flags));
    if ((ec->flags & AUTOCOMPLETE) != 0)
        jkv_bool("autocomplete", TRUE);
    if ((ec->flags & CMD_NOT_AVAILABLE) != 0)
        jkv_bool("unavailable", TRUE);
    if (param)
        jkv_str("param", param);
    jchar(',');
    jkey("keys");
    jchar('[');
    if (onlykey) {
        jint((long) onlykey);
    } else {
        for (b = gc.Cmd.cmdbinds; b; b = b->next)
            if (b->cmd == ec && !b->param && keybind_usable(b)) {
                if (!first)
                    jchar(',');
                first = FALSE;
                jint((long) b->key);
            }
    }
    jchar(']');
    jchar('}');
}

static void
emit_keybindings(void)
{
    const struct ext_func_tab *ec;
    const struct Cmd_bind *b;
    const char *dirs = gc.Cmd.dirchars;
    unsigned long sig;
    boolean first = TRUE;
    int i, ncmds;

    if (feed_fd < 0 || !gc.Cmd.cmdbinds || !dirs)
        return;
    sig = keys_signature();
    if (sent_keys && sig == sent_keys_sig)
        return;
    if (!ev_begin("keybindings"))
        return;
    sent_keys = TRUE;
    sent_keys_sig = sig;
    jkv_bool("number_pad", gc.Cmd.num_pad);
    jkv_int("num_pad_mode", (long) iflags.num_pad_mode);
    jkv_bool("rest_on_space", flags.rest_on_space);
    jkv_bool("debug", wizard);
    /* movement keys W NW N NE E SE S SW, up, down (DIR_xxx order) */
    jkv_str("dirs", dirs);
    jkv_int("extcmd_key", (long) (uchar) gc.Cmd.extcmd_char);
    jchar(',');
    jkey("commands");
    jchar('[');
    for (ncmds = 0; extcmdlist[ncmds].ef_txt; ncmds++)
        continue;
    for (ec = extcmdlist; ec->ef_txt; ec++) {
        if ((ec->flags & INTERNALCMD) != 0 || !ec->ef_desc)
            continue;
        if ((ec->flags & WIZMODECMD) != 0 && !wizard)
            continue;
        if (!first)
            jchar(',');
        first = FALSE;
        emit_keycmd(ec, (const char *) 0, 0);
    }
    for (b = gc.Cmd.cmdbinds; b; b = b->next) {
        boolean listed = (b->cmd >= extcmdlist && b->cmd < extcmdlist + ncmds);

        if (!keybind_usable(b) || !b->cmd->ef_desc)
            continue;
        if ((b->cmd->flags & WIZMODECMD) != 0 && !wizard)
            continue;
        /* parameterized bindings, and commands that are not in the
           extended command table (rest_on_space's <space>) */
        if (b->param || !listed) {
            if (!first)
                jchar(',');
            first = FALSE;
            emit_keycmd(b->cmd, b->param, (int) b->key);
        }
    }
    jchar(']');
    jchar(',');
    jkey("special");
    jchar('[');
    first = TRUE;
    for (i = 0; i < SIZE(feed_spkeys); i++) {
        uchar k = (uchar) gc.Cmd.spkeys[feed_spkeys[i].nhkf];

        if (!k || (feed_spkeys[i].numpad_only && !gc.Cmd.num_pad))
            continue;
        /* 's' is only "self" at direction prompts with number_pad */
        if (feed_spkeys[i].nhkf == NHKF_GETDIR_SELF2 && !gc.Cmd.num_pad)
            continue;
        if (!first)
            jchar(',');
        first = FALSE;
        jchar('{');
        jkey("name");
        jstr(feed_spkeys[i].name);
        jkv_str("desc", feed_spkeys[i].desc);
        jkv_int("key", (long) k);
        jchar('}');
    }
    jchar(']');
    ev_end();
}

/* bring the consumer up to date before the game blocks for input */
static void
feed_flush(void)
{
    if (feed_fd < 0)
        return;
    check_level();
    prepare_texts();
    emit_map();
    emit_inventory();
    emit_extras();
    emit_keybindings();
}

static unsigned long last_input_seq = 0;
static const char *last_input_kind = 0;

static void
emit_input(const char *kind)
{
    feed_flush();
    /* nothing happened since the identical previous marker: skip */
    if (last_input_seq && last_input_seq == feed_seq
        && last_input_kind && !strcmp(last_input_kind, kind))
        return;
    if (!ev_begin("input"))
        return;
    last_input_seq = feed_seq;
    last_input_kind = kind;
    jkv_str("kind", kind);
    jkv_int("turn", svm.moves);
    if (level_valid()) {
        jkv_int("ux", (long) u.ux);
        jkv_int("uy", (long) u.uy);
    }
    ev_end();
}

static void
emit_msg(const char *text, int attr, const char *source)
{
    if (!ev_begin("msg"))
        return;
    jkv_str("text", text);
    if (attr)
        jkv_int("attr", (long) attr);
    if (source)
        jkv_str("source", source);
    jkv_int("turn", svm.moves);
    ev_end();
}

static void
emit_text_window(winid w, const char *kind)
{
    struct feed_lines *fl;
    int i;

    if (!valid_win(w))
        return;
    fl = &wintext[w];
    if (!fl->n)
        return;
    if (ev_begin("text")) {
        jkv_int("win", (long) w);
        jkv_str("kind", kind);
        jchar(',');
        jkey("lines");
        jchar('[');
        for (i = 0; i < fl->n; i++) {
            if (i)
                jchar(',');
            jstr(fl->ln[i]);
        }
        jchar(']');
        ev_end();
    }
    lines_clear(fl);
}

/* ------------------------------------------------------------------ */
/* chain setup                                                         */

void *
feed_procs_chain(int cmd, int n, void *me, void *nextprocs, void *nextdata)
{
    struct feed_data *tdp = 0;

    switch (cmd) {
    case WINCHAIN_ALLOC:
        tdp = (struct feed_data *) alloc(sizeof *tdp);
        tdp->nprocs = 0;
        tdp->ndata = 0;
        tdp->linknum = n;
        break;
    case WINCHAIN_INIT:
        tdp = me;
        tdp->nprocs = nextprocs;
        tdp->ndata = nextdata;
        break;
    default:
        panic("feed_procs_chain: bad cmd\n");
        /*NOTREACHED*/
    }
    return tdp;
}

void
feed_procs_init(int dir)
{
    if (dir != WININIT)
        return;
    feed_open();
    if (ev_begin("hello")) {
        jkv_int("schema", FEED_SCHEMA_VERSION);
        jkv_int("pid", (long) getpid());
        jkv_int("version_major", VERSION_MAJOR);
        jkv_int("version_minor", VERSION_MINOR);
        jkv_int("patchlevel", PATCHLEVEL);
        jkv_int("cols", COLNO);
        jkv_int("rows", ROWNO);
        ev_end();
    }
}

/* ------------------------------------------------------------------ */
/* window procedures                                                   */

void
feed_init_nhwindows(void *vp, int *argcp, char **argv)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_init_nhwindows)(tdp->ndata, argcp, argv);
}

void
feed_player_selection(void *vp)
{
    struct feed_data *tdp = vp;

    emit_input("player_selection");
    (*NEXT(tdp)->win_player_selection)(tdp->ndata);
}

void
feed_askname(void *vp)
{
    struct feed_data *tdp = vp;

    emit_input("askname");
    (*NEXT(tdp)->win_askname)(tdp->ndata);
}

void
feed_get_nh_event(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_get_nh_event)(tdp->ndata);
}

void
feed_exit_nhwindows(void *vp, const char *str)
{
    struct feed_data *tdp = vp;

    if (ev_begin("exit")) {
        jkv_str("text", str ? str : "");
        ev_end();
    }
    (*NEXT(tdp)->win_exit_nhwindows)(tdp->ndata, str);
}

void
feed_suspend_nhwindows(void *vp, const char *str)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_suspend_nhwindows)(tdp->ndata, str);
}

void
feed_resume_nhwindows(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_resume_nhwindows)(tdp->ndata);
}

winid
feed_create_nhwindow(void *vp, int type)
{
    struct feed_data *tdp = vp;
    winid w;

    if (sb_capture)
        return FEED_CAPWIN;
    w = (*NEXT(tdp)->win_create_nhwindow)(tdp->ndata, type);

    if (valid_win(w)) {
        wintypes[w] = type;
        lines_clear(&wintext[w]);
        menu_clear(&winmenu[w]);
    }
    return w;
}

void
feed_clear_nhwindow(void *vp, winid window)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window))
        return;
    note_origin(window);
    if (window == WIN_MAP && window != WIN_ERR) {
        /* level changes clear the map first; announce the new level
           before the clear so consumers keep the old level's memory */
        check_level();
        memset(cells, 0, sizeof cells);
        map_dirty = FALSE;
        if (ev_begin("map_clear")) {
            if (level_valid()) {
                jkv_int("dnum", (long) u.uz.dnum);
                jkv_int("dlevel", (long) u.uz.dlevel);
            }
            ev_end();
        }
    } else if (valid_win(window) && window != WIN_MESSAGE
               && window != WIN_STATUS) {
        lines_clear(&wintext[window]);
    }
    (*NEXT(tdp)->win_clear_nhwindow)(tdp->ndata, window);
}

void
feed_display_nhwindow(void *vp, winid window, boolean blocking)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return; /* never wait for the player in the sandbox */
    if (valid_win(window) && wintext[window].n) {
        emit_text_window(window,
                         wintypes[window] == NHW_MENU ? "menu_text" : "text");
        emit_input("dismiss");
    } else if (window == WIN_MESSAGE && blocking) {
        emit_input("more");
    } else if (blocking && window != WIN_MAP) {
        emit_input("dismiss");
    }
    (*NEXT(tdp)->win_display_nhwindow)(tdp->ndata, window, blocking);
}

void
feed_destroy_nhwindow(void *vp, winid window)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window))
        return;
    if (valid_win(window)) {
        lines_clear(&wintext[window]);
        menu_clear(&winmenu[window]);
        wintypes[window] = 0;
    }
    (*NEXT(tdp)->win_destroy_nhwindow)(tdp->ndata, window);
}

void
feed_curs(void *vp, winid window, int x, int y)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window))
        return;
    (*NEXT(tdp)->win_curs)(tdp->ndata, window, x, y);
}

static void
note_putstr(winid window, int attr, const char *str)
{
    if (feed_fd < 0 || !str)
        return;
    if (window == WIN_MESSAGE && window != WIN_ERR) {
        emit_msg(str, attr, (const char *) 0);
    } else if (window == WIN_MAP || window == WIN_STATUS) {
        ; /* map is reported via print_glyph, status via status_update */
    } else if (valid_win(window)) {
        lines_add(&wintext[window], str);
    }
}

void
feed_putstr(void *vp, winid window, int attr, const char *str)
{
    struct feed_data *tdp = vp;

    if (sb_capture) {
        if (window == FEED_CAPWIN && str)
            sb_put(str);
        return; /* messages from the captured command are dropped */
    }
    note_putstr(window, attr, str);
    (*NEXT(tdp)->win_putstr)(tdp->ndata, window, attr, str);
}

void
feed_putmixed(void *vp, winid window, int attr, const char *str)
{
    struct feed_data *tdp = vp;

    if (sb_capture) {
        char buf[BUFSZ * 2];

        if (window == FEED_CAPWIN && str)
            sb_put(strlen(str) < BUFSZ ? decode_mixed(buf, str) : str);
        return;
    }
    if (feed_fd >= 0 && str) {
        char buf[BUFSZ * 2];

        if (strlen(str) < BUFSZ)
            note_putstr(window, attr, decode_mixed(buf, str));
        else
            note_putstr(window, attr, str);
    }
    (*NEXT(tdp)->win_putmixed)(tdp->ndata, window, attr, str);
}

void
feed_display_file(void *vp, const char *fname, boolean complain)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return;
    if (ev_begin("display_file")) {
        jkv_str("name", fname);
        ev_end();
    }
    emit_input("dismiss");
    (*NEXT(tdp)->win_display_file)(tdp->ndata, fname, complain);
}

void
feed_start_menu(void *vp, winid window, unsigned long mbehavior)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window))
        return;
    if (valid_win(window)) {
        menu_clear(&winmenu[window]);
        lines_clear(&wintext[window]);
        winmenu[window].mbehavior = mbehavior;
    }
    (*NEXT(tdp)->win_start_menu)(tdp->ndata, window, mbehavior);
}

void
feed_add_menu(void *vp, winid window, const glyph_info *glyphinfo,
              const ANY_P *identifier, char ch, char gch, int attr, int clr,
              const char *str, unsigned int itemflags)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window)) {
        if (str)
            sb_put(str);
        return;
    }
    if (valid_win(window) && feed_fd >= 0) {
        struct feed_menu *m = &winmenu[window];

        if (m->n >= m->cap) {
            int ncap = m->cap ? m->cap * 2 : 32;
            struct feed_menuitem *ni = (struct feed_menuitem *) realloc(
                m->items, ncap * sizeof *ni);

            if (ni)
                m->items = ni, m->cap = ncap;
        }
        if (m->n < m->cap) {
            struct feed_menuitem *it = &m->items[m->n++];

            it->ch = ch;
            it->gch = gch;
            it->attr = attr;
            it->clr = clr;
            it->selectable = (identifier && identifier->a_void != 0);
            it->preselected = (itemflags & MENU_ITEMFLAGS_SELECTED) != 0;
            it->text = dupstr(str ? str : "");
        }
    }
    (*NEXT(tdp)->win_add_menu)(tdp->ndata, window, glyphinfo, identifier, ch,
                               gch, attr, clr, str, itemflags);
}

void
feed_end_menu(void *vp, winid window, const char *prompt)
{
    struct feed_data *tdp = vp;

    if (CAPWIN(window))
        return;
    if (valid_win(window)) {
        if (winmenu[window].prompt)
            free(winmenu[window].prompt);
        winmenu[window].prompt = prompt ? dupstr(prompt) : 0;
    }
    (*NEXT(tdp)->win_end_menu)(tdp->ndata, window, prompt);
}

/* Copy the selector letters tty shows (it assigns a-z/A-Z per page to
   items the core gave no accelerator) and the page layout from tty's own
   menu structure, filled in by tty_end_menu().  Returns the page count. */
static int
menu_read_tty_layout(winid window, struct feed_menu *m)
{
    int i, pages = 0;

    for (i = 0; i < m->n; i++) {
        m->items[i].shown = m->items[i].ch;
        m->items[i].page = 0;
    }
#ifdef TTY_GRAPHICS
    if (WINDOWPORT(tty) && window >= 0 && window < MAXWIN && wins[window]
        && wins[window]->type == NHW_MENU && wins[window]->mlist) {
        struct WinDesc *cw = wins[window];
        tty_menu_item *curr;
        int n = 0, skip, page = 0;

        for (curr = cw->mlist; curr; curr = curr->next)
            n++;
        /* tty puts the prompt (blank line + prompt) in front of the items */
        skip = n - m->n;
        if (skip < 0)
            return 0;
        pages = (int) cw->npages;
        for (i = -skip, curr = cw->mlist; curr && i < m->n;
             i++, curr = curr->next) {
            if (cw->plist && page + 1 < cw->npages
                && curr == cw->plist[page + 1])
                page++;
            if (i < 0)
                continue;
            if (curr->identifier.a_void)
                m->items[i].shown = curr->selector;
            m->items[i].page = page + 1;
        }
    }
#endif
    return pages;
}

int
feed_select_menu(void *vp, winid window, int how, MENU_ITEM_P **menu_list)
{
    struct feed_data *tdp = vp;
    int rv, i;

    if (sb_capture) {
        *menu_list = (MENU_ITEM_P *) 0;
        return 0;
    }
    feed_flush();
    if (valid_win(window) && ev_begin("menu")) {
        struct feed_menu *m = &winmenu[window];
        char cbuf[2];
        int pages = menu_read_tty_layout(window, m);

        jkv_int("win", (long) window);
        jkv_str("how", how == PICK_NONE ? "none"
                       : how == PICK_ONE ? "one" : "any");
        jkv_str("prompt", m->prompt ? m->prompt : "");
        if (pages)
            jkv_int("pages", (long) pages);
        jchar(',');
        jkey("items");
        jchar('[');
        for (i = 0; i < m->n; i++) {
            struct feed_menuitem *it = &m->items[i];

            if (i)
                jchar(',');
            jcat("{\"text\":");
            jstr(it->text);
            cbuf[0] = it->shown, cbuf[1] = '\0';
            if (it->shown)
                jkv_str("ch", cbuf);
            if (it->shown && !it->ch)
                jkv_bool("assigned", TRUE);
            if (it->page)
                jkv_int("page", (long) it->page);
            jkv_bool("selectable", it->selectable);
            if (it->preselected)
                jkv_bool("selected", TRUE);
            if (it->attr)
                jkv_int("attr", (long) it->attr);
            jchar('}');
        }
        jchar(']');
        ev_end();
    }
    emit_input("menu");
    rv = (*NEXT(tdp)->win_select_menu)(tdp->ndata, window, how, menu_list);
    if (ev_begin("menu_done")) {
        jkv_int("win", (long) window);
        jkv_int("count", (long) rv);
        ev_end();
    }
    return rv;
}

char
feed_message_menu(void *vp, char let, int how, const char *mesg)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return '\033';
    if (mesg)
        emit_msg(mesg, 0, "message_menu");
    return (*NEXT(tdp)->win_message_menu)(tdp->ndata, let, how, mesg);
}

void
feed_mark_synch(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_mark_synch)(tdp->ndata);
}

void
feed_wait_synch(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_wait_synch)(tdp->ndata);
}

#ifdef CLIPPING
void
feed_cliparound(void *vp, int x, int y)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_cliparound)(tdp->ndata, x, y);
}
#endif

#ifdef POSITIONBAR
void
feed_update_positionbar(void *vp, char *posbar)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_update_positionbar)(tdp->ndata, posbar);
}
#endif

void
feed_print_glyph(void *vp, winid window, coordxy x, coordxy y,
                 const glyph_info *glyphinfo, const glyph_info *bkglyphinfo)
{
    struct feed_data *tdp = vp;

    if (window == WIN_MAP && window != WIN_ERR && glyphinfo
        && x >= 0 && x < COLNO && y >= 0 && y < ROWNO) {
        struct feed_cell *c = &cells[x][y];

        c->glyph = glyphinfo->glyph;
        c->ttychar = glyphinfo->ttychar;
        c->color = glyphinfo->gm.sym.color;
        c->glyphflags = glyphinfo->gm.glyphflags;
        c->dirty = TRUE;
        map_dirty = TRUE;
    }
    (*NEXT(tdp)->win_print_glyph)(tdp->ndata, window, x, y, glyphinfo,
                                  bkglyphinfo);
}

void
feed_raw_print(void *vp, const char *str)
{
    struct feed_data *tdp = vp;

    if (str)
        emit_msg(str, 0, "raw_print");
    (*NEXT(tdp)->win_raw_print)(tdp->ndata, str);
}

void
feed_raw_print_bold(void *vp, const char *str)
{
    struct feed_data *tdp = vp;

    if (str)
        emit_msg(str, ATR_BOLD, "raw_print");
    (*NEXT(tdp)->win_raw_print_bold)(tdp->ndata, str);
}

int
feed_nhgetch(void *vp)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return '\033';
    emit_input("key");
    return (*NEXT(tdp)->win_nhgetch)(tdp->ndata);
}

int
feed_nh_poskey(void *vp, coordxy *x, coordxy *y, int *mod)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return '\033';
    emit_input(iflags.in_parse ? "command" : "key");
    return (*NEXT(tdp)->win_nh_poskey)(tdp->ndata, x, y, mod);
}

void
feed_nhbell(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_nhbell)(tdp->ndata);
}

int
feed_doprev_message(void *vp)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_doprev_message)(tdp->ndata);
}

char
feed_yn_function(void *vp, const char *query, const char *resp, char def)
{
    struct feed_data *tdp = vp;
    char rv, dbuf[2];

    if (sb_capture)
        return def ? def : '\033';
    feed_flush();
    if (ev_begin("input")) {
        jkv_str("kind", "yn");
        jkv_str("prompt", query ? query : "");
        jkv_str("choices", resp ? resp : "");
        dbuf[0] = def, dbuf[1] = '\0';
        jkv_str("default", dbuf);
        jkv_int("turn", svm.moves);
        ev_end();
    }
    rv = (*NEXT(tdp)->win_yn_function)(tdp->ndata, query, resp, def);
    if (ev_begin("answer")) {
        dbuf[0] = rv, dbuf[1] = '\0';
        jkv_str("kind", "yn");
        jkv_str("prompt", query ? query : "");
        jkv_str("value", dbuf);
        ev_end();
    }
    return rv;
}

void
feed_getlin(void *vp, const char *query, char *bufp)
{
    struct feed_data *tdp = vp;

    if (sb_capture) {
        Strcpy(bufp, "\033");
        return;
    }
    feed_flush();
    if (ev_begin("input")) {
        jkv_str("kind", "getlin");
        jkv_str("prompt", query ? query : "");
        jkv_int("turn", svm.moves);
        ev_end();
    }
    (*NEXT(tdp)->win_getlin)(tdp->ndata, query, bufp);
}

int
feed_get_ext_cmd(void *vp)
{
    struct feed_data *tdp = vp;

    if (sb_capture)
        return -1;
    emit_input("extcmd");
    return (*NEXT(tdp)->win_get_ext_cmd)(tdp->ndata);
}

void
feed_number_pad(void *vp, int state)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_number_pad)(tdp->ndata, state);
}

void
feed_delay_output(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_delay_output)(tdp->ndata);
}

#ifdef CHANGE_COLOR
void
feed_change_color(void *vp, int color, long rgb, int reverse)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_change_color)(tdp->ndata, color, rgb, reverse);
}

#ifdef MACOS9
void
feed_change_background(void *vp, int bw)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_change_background)(tdp->ndata, bw);
}

short
feed_set_font_name(void *vp, winid window, char *font)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_set_font_name)(tdp->ndata, window, font);
}
#endif

char *
feed_get_color_string(void *vp)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_get_color_string)(tdp->ndata);
}
#endif

void
feed_outrip(void *vp, winid tmpwin, int how, time_t when)
{
    struct feed_data *tdp = vp;

    if (ev_begin("gameover")) {
        jkv_int("how", (long) how);
        jkv_int("turn", svm.moves);
        ev_end();
    }
    (*NEXT(tdp)->win_outrip)(tdp->ndata, tmpwin, how, when);
}

void
feed_preference_update(void *vp, const char *pref)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_preference_update)(tdp->ndata, pref);
}

char *
feed_getmsghistory(void *vp, boolean init)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_getmsghistory)(tdp->ndata, init);
}

void
feed_putmsghistory(void *vp, const char *msg, boolean is_restoring)
{
    struct feed_data *tdp = vp;

    if (msg && is_restoring)
        emit_msg(msg, 0, "history");
    (*NEXT(tdp)->win_putmsghistory)(tdp->ndata, msg, is_restoring);
}

void
feed_status_init(void *vp)
{
    struct feed_data *tdp = vp;

    memset(statvalid, 0, sizeof statvalid);
    (*NEXT(tdp)->win_status_init)(tdp->ndata);
}

void
feed_status_finish(void *vp)
{
    struct feed_data *tdp = vp;

    (*NEXT(tdp)->win_status_finish)(tdp->ndata);
}

void
feed_status_enablefield(void *vp, int fieldidx, const char *nm,
                        const char *fmt, boolean enable)
{
    struct feed_data *tdp = vp;

    if (fieldidx >= 0 && fieldidx < MAXBLSTATS && !enable)
        statvalid[fieldidx] = FALSE;
    (*NEXT(tdp)->win_status_enablefield)(tdp->ndata, fieldidx, nm, fmt,
                                         enable);
}

void
feed_status_update(void *vp, int idx, genericptr_t ptr, int chg, int percent,
                   int color, unsigned long *colormasks)
{
    struct feed_data *tdp = vp;

    if (idx == BL_FLUSH || idx == BL_RESET) {
        if (feed_fd >= 0)
            emit_status();
    } else if (idx == BL_CONDITION && ptr) {
        statcond = *(long *) ptr;
        statvalid[idx] = TRUE;
    } else if (idx >= 0 && idx < MAXBLSTATS && ptr) {
        const char *text = (const char *) ptr;
        char goldbuf[BUFSZ];

        if (idx == BL_GOLD && strlen(text) < BUFSZ)
            text = decode_mixed(goldbuf, text);
        /* gold is shown as "$:123"; keep only the number */
        if (idx == BL_GOLD) {
            const char *colon = strchr(text, ':');

            if (colon)
                text = colon + 1;
        }
        (void) strncpy(statvals[idx], text, FEED_STATVAL - 1);
        statvals[idx][FEED_STATVAL - 1] = '\0';
        (void) trimspaces(statvals[idx]);
        statcolor[idx] = color;
        statvalid[idx] = TRUE;
    }
    (*NEXT(tdp)->win_status_update)(tdp->ndata, idx, ptr, chg, percent,
                                    color, colormasks);
}

boolean
feed_can_suspend(void *vp)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_can_suspend)(tdp->ndata);
}

void
feed_update_inventory(void *vp, int arg)
{
    struct feed_data *tdp = vp;

    inv_dirty = TRUE;
    (*NEXT(tdp)->win_update_inventory)(tdp->ndata, arg);
}

win_request_info *
feed_ctrl_nhwindow(void *vp, winid w, int request, win_request_info *wri)
{
    struct feed_data *tdp = vp;

    return (*NEXT(tdp)->win_ctrl_nhwindow)(tdp->ndata, w, request, wri);
}

struct chain_procs feed_procs = {
    "+feed", wp_trace, /* no dedicated wp_id; chain links share wp_trace */
    0,                 /* wincap */
    0,                 /* wincap2 */
    { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 },
    feed_init_nhwindows, feed_player_selection, feed_askname,
    feed_get_nh_event, feed_exit_nhwindows, feed_suspend_nhwindows,
    feed_resume_nhwindows, feed_create_nhwindow, feed_clear_nhwindow,
    feed_display_nhwindow, feed_destroy_nhwindow, feed_curs, feed_putstr,
    feed_putmixed, feed_display_file, feed_start_menu, feed_add_menu,
    feed_end_menu, feed_select_menu, feed_message_menu, feed_mark_synch,
    feed_wait_synch,
#ifdef CLIPPING
    feed_cliparound,
#endif
#ifdef POSITIONBAR
    feed_update_positionbar,
#endif
    feed_print_glyph, feed_raw_print, feed_raw_print_bold, feed_nhgetch,
    feed_nh_poskey, feed_nhbell, feed_doprev_message, feed_yn_function,
    feed_getlin, feed_get_ext_cmd, feed_number_pad, feed_delay_output,
#ifdef CHANGE_COLOR
    feed_change_color,
#ifdef MACOS9
    feed_change_background, feed_set_font_name,
#endif
    feed_get_color_string,
#endif
    feed_outrip, feed_preference_update, feed_getmsghistory,
    feed_putmsghistory, feed_status_init, feed_status_finish,
    feed_status_enablefield, feed_status_update, feed_can_suspend,
    feed_update_inventory, feed_ctrl_nhwindow
};

/* wc_feed.c */
