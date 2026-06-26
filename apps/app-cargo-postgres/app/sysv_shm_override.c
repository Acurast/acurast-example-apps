/*
 * SysV shared-memory shim for the proot/Acurast Cargo sandbox.
 *
 * The sandbox kernel does not implement the System V IPC shared-memory
 * syscalls (shmget/shmat/shmdt/shmctl return ENOSYS, "Function not
 * implemented"). PostgreSQL always creates a small SysV segment as a
 * data-directory interlock — even when shared_memory_type=mmap — so it
 * cannot start without these.
 *
 * This shim emulates the SysV shm API with anonymous MAP_SHARED mmaps,
 * which are shared across fork() exactly like real SysV segments, so the
 * postmaster and its backends see the same memory. It is intentionally
 * minimal: enough for a single PostgreSQL instance, not a general SysV IPC
 * implementation. Injected via LD_PRELOAD, same pattern as the getifaddrs
 * shim used elsewhere in this repo.
 */
#define _GNU_SOURCE
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/mman.h>
#include <string.h>
#include <errno.h>
#include <stddef.h>

#define MAX_SEG 256
#define ID_BASE 0x53480000 /* arbitrary, distinguishes our ids */

static struct {
    int    used;
    key_t  key;
    void  *addr;
    size_t size;
} segs[MAX_SEG];

static int id_for(int i)  { return ID_BASE + i; }
static int idx_of(int id) { int i = id - ID_BASE; return (i >= 0 && i < MAX_SEG) ? i : -1; }

int shmget(key_t key, size_t size, int shmflg) {
    if (key != IPC_PRIVATE) {
        for (int i = 0; i < MAX_SEG; i++) {
            if (segs[i].used && segs[i].key == key) {
                if ((shmflg & IPC_CREAT) && (shmflg & IPC_EXCL)) {
                    errno = EEXIST;
                    return -1;
                }
                return id_for(i);
            }
        }
    }
    if (!(shmflg & IPC_CREAT) && key != IPC_PRIVATE) {
        errno = ENOENT;
        return -1;
    }
    size_t len = size ? size : 1;
    for (int i = 0; i < MAX_SEG; i++) {
        if (!segs[i].used) {
            void *a = mmap(NULL, len, PROT_READ | PROT_WRITE,
                           MAP_SHARED | MAP_ANONYMOUS, -1, 0);
            if (a == MAP_FAILED) {
                errno = ENOMEM;
                return -1;
            }
            memset(a, 0, len);
            segs[i].used = 1;
            segs[i].key  = key;
            segs[i].addr = a;
            segs[i].size = len;
            return id_for(i);
        }
    }
    errno = ENOSPC;
    return -1;
}

void *shmat(int shmid, const void *shmaddr, int shmflg) {
    (void) shmaddr;
    (void) shmflg;
    int i = idx_of(shmid);
    if (i < 0 || !segs[i].used) {
        errno = EINVAL;
        return (void *) -1;
    }
    return segs[i].addr;
}

int shmdt(const void *shmaddr) {
    (void) shmaddr;
    return 0;
}

int shmctl(int shmid, int cmd, struct shmid_ds *buf) {
    int i = idx_of(shmid);
    if (i < 0 || !segs[i].used) {
        errno = EINVAL;
        return -1;
    }
    if (cmd == IPC_STAT) {
        if (buf) {
            memset(buf, 0, sizeof(*buf));
            buf->shm_segsz  = segs[i].size;
            buf->shm_nattch = 1;
        }
        return 0;
    }
    if (cmd == IPC_RMID) {
        munmap(segs[i].addr, segs[i].size);
        segs[i].used = 0;
        return 0;
    }
    return 0;
}
