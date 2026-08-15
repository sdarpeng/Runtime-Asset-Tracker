#!/usr/bin/env python3
"""Delete one attested path using POSIX directory descriptors only."""

import argparse
import os
import stat
import uuid


def identity(info):
    return int(info.st_dev), int(info.st_ino)


def mount_id(descriptor):
    try:
        with open(f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("mnt_id:"):
                    return int(line.split(":", 1)[1].strip())
    except Exception as error:
        raise RuntimeError("mount identity is unavailable") from error
    raise RuntimeError("mount identity is unavailable")


def open_directory(name, *, dir_fd=None):
    required = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, flag) for flag in required):
        raise RuntimeError("O_DIRECTORY and O_NOFOLLOW are required")
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)


def remove_contents(directory_fd, device, expected_mount_id):
    for name in os.listdir(directory_fd):
        if name in (".", ".."):
            raise RuntimeError("unexpected directory entry")
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if before.st_dev != device:
            raise RuntimeError("cross-device entry is blocked")
        if not hasattr(os, "O_PATH"):
            raise RuntimeError("O_PATH is required for mount-safe cleanup")
        entry_fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory_fd)
        try:
            opened_entry = os.fstat(entry_fd)
            if identity(opened_entry) != identity(before) or mount_id(entry_fd) != expected_mount_id:
                raise RuntimeError("entry identity or mount changed before removal")
        finally:
            os.close(entry_fd)
        if stat.S_ISDIR(before.st_mode):
            child_fd = open_directory(name, dir_fd=directory_fd)
            try:
                opened = os.fstat(child_fd)
                if identity(opened) != identity(before) or opened.st_dev != device or mount_id(child_fd) != expected_mount_id:
                    raise RuntimeError("directory identity changed before traversal")
                remove_contents(child_fd, device, expected_mount_id)
                current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if identity(current) != identity(opened):
                    raise RuntimeError("directory identity changed before removal")
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            os.unlink(name, dir_fd=directory_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--root-dev", required=True, type=int)
    parser.add_argument("--root-ino", required=True, type=int)
    parser.add_argument("--target-dev", required=True, type=int)
    parser.add_argument("--target-ino", required=True, type=int)
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    target = os.path.abspath(args.path)
    relative = os.path.relpath(target, root)
    parts = [part for part in relative.split(os.sep) if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise RuntimeError("target is outside the managed root")

    root_fd = open_directory(root)
    parent_fd = root_fd
    quarantine = None
    target_name = parts[-1]
    try:
        if identity(os.fstat(root_fd)) != (args.root_dev, args.root_ino):
            raise RuntimeError("managed root identity changed")
        root_mount_id = mount_id(root_fd)
        for part in parts[:-1]:
            next_fd = open_directory(part, dir_fd=parent_fd)
            if mount_id(next_fd) != root_mount_id:
                os.close(next_fd)
                raise RuntimeError("mount transition below managed root is blocked")
            if parent_fd != root_fd:
                os.close(parent_fd)
            parent_fd = next_fd

        before = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
        if identity(before) != (args.target_dev, args.target_ino) or stat.S_ISLNK(before.st_mode):
            raise RuntimeError("target identity changed before isolation")
        if not hasattr(os, "O_PATH"):
            raise RuntimeError("O_PATH is required for mount-safe cleanup")
        target_identity_fd = os.open(target_name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            if identity(os.fstat(target_identity_fd)) != identity(before) or mount_id(target_identity_fd) != root_mount_id:
                raise RuntimeError("target mount transition is blocked")
        finally:
            os.close(target_identity_fd)
        quarantine = f".runtime-asset-trash-{uuid.uuid4().hex}"
        os.rename(target_name, quarantine, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        isolated = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
        if identity(isolated) != (args.target_dev, args.target_ino):
            try:
                os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                os.rename(quarantine, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            raise RuntimeError("target identity changed during isolation")

        if stat.S_ISDIR(isolated.st_mode):
            target_fd = open_directory(quarantine, dir_fd=parent_fd)
            try:
                opened = os.fstat(target_fd)
                if identity(opened) != identity(isolated):
                    raise RuntimeError("isolated directory identity changed")
                if mount_id(target_fd) != root_mount_id:
                    raise RuntimeError("isolated target mount transition is blocked")
                remove_contents(target_fd, isolated.st_dev, root_mount_id)
                current = os.stat(quarantine, dir_fd=parent_fd, follow_symlinks=False)
                if identity(current) != identity(opened):
                    raise RuntimeError("isolated directory identity changed before removal")
            finally:
                os.close(target_fd)
            os.rmdir(quarantine, dir_fd=parent_fd)
        else:
            os.unlink(quarantine, dir_fd=parent_fd)
        quarantine = None
    finally:
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


if __name__ == "__main__":
    main()
