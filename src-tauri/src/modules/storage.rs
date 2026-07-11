use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::NamedTempFile;

pub struct FileLock(File);

impl FileLock {
    pub fn try_acquire(path: &Path) -> io::Result<Option<Self>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(Self(file))),
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub fn acquire(path: &Path, timeout: Duration) -> io::Result<Option<Self>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(lock) = Self::try_acquire(path)? {
                return Ok(Some(lock));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    std::fs::create_dir_all(parent)?;

    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file_mut().sync_all()?;

    #[cfg(not(windows))]
    {
        std::fs::rename(temp.path(), path)?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source: Vec<u16> = temp
            .path()
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let target: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let (_file, temp_path) = temp.keep()?;
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            let error = io::Error::last_os_error();
            let _ = std::fs::remove_file(temp_path);
            return Err(error);
        }
    }

    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resource.lock");
        let first = FileLock::try_acquire(&path).unwrap().unwrap();
        assert!(FileLock::try_acquire(&path).unwrap().is_none());
        drop(first);
        assert!(FileLock::try_acquire(&path).unwrap().is_some());
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("value.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn subprocess_lock_helper() {
        let Some(lock_path) = std::env::var_os("TERAX_TEST_LOCK_PATH") else {
            return;
        };
        let ready = std::path::PathBuf::from(std::env::var_os("TERAX_TEST_READY").unwrap());
        let release = std::path::PathBuf::from(std::env::var_os("TERAX_TEST_RELEASE").unwrap());
        let _lock = FileLock::try_acquire(Path::new(&lock_path))
            .unwrap()
            .unwrap();
        std::fs::write(&ready, b"ready").unwrap();
        wait_for(&release);
    }

    #[test]
    fn lock_is_exclusive_across_processes_and_released_on_exit() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("cross-process.lock");
        let ready = dir.path().join("ready");
        let release = dir.path().join("release");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("modules::storage::tests::subprocess_lock_helper")
            .arg("--nocapture")
            .env("TERAX_TEST_LOCK_PATH", &lock_path)
            .env("TERAX_TEST_READY", &ready)
            .env("TERAX_TEST_RELEASE", &release)
            .spawn()
            .unwrap();

        wait_for(&ready);
        assert!(FileLock::try_acquire(&lock_path).unwrap().is_none());
        std::fs::write(&release, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(FileLock::try_acquire(&lock_path).unwrap().is_some());
    }
}
