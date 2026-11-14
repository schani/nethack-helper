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
 * NetHack may be freely redistributed.  See license for details.
 */

#include "hack.h"
#include "dungeon.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define FEED_SCHEMA_VERSION 1

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
/* tracked state                                                       */

#define FEED_MAXWIN 64
static int wintypes[FEED_MAXWIN]; /* NHW_xxx, 0 = unknown */

/* buffered text lines for NHW_TEXT / NHW_MENU windows used as text */
struct feed_lines {
    char **lines;
    int n, cap;
};
static struct feed_lines wintext[FEED_MAXWIN];

/* menu under construction per window */
struct feed_menuitem {
    char ch, gch;
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
        free(fl->lines[i]);
    fl->n = 0;
}

static void
lines_add(struct feed_lines *fl, const char *s)
{
    if (fl->n >= fl->cap) {
        int ncap = fl->cap ? fl->cap * 2 : 32;
        char **nl = (char **) realloc(fl->lines, ncap * sizeof(char *));

        if (!nl)
            return;
        fl->lines = nl;
        fl->cap = ncap;
    }
    fl->lines[fl->n++] = dupstr(s ? s : "");
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

static void
check_level(void)
{
    if (feed_fd < 0 || !level_valid())
        return;
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

static void
emit_map(void)
{
    coordxy x, y;
    boolean first = TRUE;
    char sbuf[BUFSZ], lbuf[BUFSZ], chbuf[2];

    if (!map_dirty || feed_fd < 0 || !level_valid())
        return;
    if (!ev_begin("map"))
        return;
    jkv_int("dnum", (long) u.uz.dnum);
    jkv_int("dlevel", (long) u.uz.dlevel);
    jchar(',');
    jkey("cells");
    jchar('[');
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
            if (glyph_is_unexplored(c->glyph)) {
                Strcpy(sbuf, "unexplored area");
                Strcpy(lbuf, sbuf);
            } else {
                describe_cell(x, y, sbuf, lbuf);
            }
            jkv_str("desc", sbuf);
            jkv_str("look", lbuf);
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

    if (!inv_dirty || feed_fd < 0
        || !(program_state.in_moveloop || program_state.gameover))
        return;
    inv_dirty = FALSE;
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
        jkv_str("text", doname(otmp));
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

/* bring the consumer up to date before the game blocks for input */
static void
feed_flush(void)
{
    if (feed_fd < 0)
        return;
    check_level();
    emit_map();
    emit_inventory();
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
            jstr(fl->lines[i]);
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
    winid w = (*NEXT(tdp)->win_create_nhwindow)(tdp->ndata, type);

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

    note_putstr(window, attr, str);
    (*NEXT(tdp)->win_putstr)(tdp->ndata, window, attr, str);
}

void
feed_putmixed(void *vp, winid window, int attr, const char *str)
{
    struct feed_data *tdp = vp;

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

    if (valid_win(window)) {
        if (winmenu[window].prompt)
            free(winmenu[window].prompt);
        winmenu[window].prompt = prompt ? dupstr(prompt) : 0;
    }
    (*NEXT(tdp)->win_end_menu)(tdp->ndata, window, prompt);
}

int
feed_select_menu(void *vp, winid window, int how, MENU_ITEM_P **menu_list)
{
    struct feed_data *tdp = vp;
    int rv, i;

    feed_flush();
    if (valid_win(window) && ev_begin("menu")) {
        struct feed_menu *m = &winmenu[window];
        char cbuf[2];

        jkv_int("win", (long) window);
        jkv_str("how", how == PICK_NONE ? "none"
                       : how == PICK_ONE ? "one" : "any");
        jkv_str("prompt", m->prompt ? m->prompt : "");
        jchar(',');
        jkey("items");
        jchar('[');
        for (i = 0; i < m->n; i++) {
            struct feed_menuitem *it = &m->items[i];

            if (i)
                jchar(',');
            jcat("{\"text\":");
            jstr(it->text);
            cbuf[0] = it->ch, cbuf[1] = '\0';
            if (it->ch)
                jkv_str("ch", cbuf);
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

    emit_input("key");
    return (*NEXT(tdp)->win_nhgetch)(tdp->ndata);
}

int
feed_nh_poskey(void *vp, coordxy *x, coordxy *y, int *mod)
{
    struct feed_data *tdp = vp;

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
