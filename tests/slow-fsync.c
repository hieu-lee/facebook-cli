#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void stall(const char *marker, const char *release) {
    if (marker && release) {
        int mark = open(marker, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
        if (mark >= 0) close(mark);
        while (access(release, F_OK) != 0) usleep(10000);
    }
}

int fsync(int fd) {
    stall(getenv("FB_TEST_SYNC_MARKER"), getenv("FB_TEST_SYNC_RELEASE"));
    int (*next)(int) = dlsym(RTLD_NEXT, "fsync");
    return next(fd);
}

int unlink(const char *path) {
    if (strstr(path, "/.fb-record-")) stall(getenv("FB_TEST_UNLINK_MARKER"), getenv("FB_TEST_UNLINK_RELEASE"));
    int (*next)(const char *) = dlsym(RTLD_NEXT, "unlink");
    return next(path);
}

int rename(const char *old_path, const char *new_path) {
    const char *target = getenv("FB_TEST_RENAME_TARGET");
    if (target && strcmp(target, new_path) == 0) stall(getenv("FB_TEST_RENAME_MARKER"), getenv("FB_TEST_RENAME_RELEASE"));
    int (*next)(const char *, const char *) = dlsym(RTLD_NEXT, "rename");
    return next(old_path, new_path);
}

static void metadata(const char *path) {
    static atomic_int checks;
    const char *target = getenv("FB_TEST_METADATA_TARGET"), *index = getenv("FB_TEST_METADATA_INDEX");
    if (target && index && path && strcmp(target, path) == 0 && atomic_fetch_add(&checks, 1) + 1 == atoi(index))
        stall(getenv("FB_TEST_METADATA_MARKER"), getenv("FB_TEST_METADATA_RELEASE"));
}

int lstat64(const char *path, struct stat64 *result) {
    metadata(path);
    int (*next)(const char *, struct stat64 *) = dlsym(RTLD_NEXT, "lstat64");
    return next(path, result);
}

int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *result) {
    metadata(path);
    int (*next)(int, const char *, int, unsigned int, struct statx *) = dlsym(RTLD_NEXT, "statx");
    return next(dirfd, path, flags, mask, result);
}

ssize_t write(int fd, const void *data, size_t size) {
    static _Thread_local int inside;
    const char *target = getenv("FB_TEST_WRITE_TARGET");
    if (!inside && target) {
        char link[64], path[4096];
        inside = 1;
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t length = readlink(link, path, sizeof(path) - 1);
        if (length >= 0) {
            path[length] = 0;
            if (strcmp(path, target) == 0 || strstr(path, "/.fb-record-"))
                stall(getenv("FB_TEST_WRITE_MARKER"), getenv("FB_TEST_WRITE_RELEASE"));
        }
        inside = 0;
    }
    ssize_t (*next)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    return next(fd, data, size);
}
