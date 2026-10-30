//! Windows 子进程树的 Job Object 所有权。
//!
//! Shell 进程先以挂起状态创建，加入启用 `KILL_ON_JOB_CLOSE` 的 Job Object 后再恢复，
//! 避免子进程在归属建立前逃逸。既有调用方仍可接管已经启动的进程。

#![cfg(windows)]

use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::process::CommandExt;
use std::process::Command;

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

use shared_child::SharedChild;

/// 持有一个启用关闭即终止的 Windows Job Object。
pub struct ProcessJob {
    handle: HANDLE,
}

unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// 创建一个空 Job Object，并启用关闭句柄时终止全部成员进程。
    fn create() -> io::Result<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self { handle: job })
        }
    }

    /// 以挂起状态启动进程，在其执行任何用户代码前加入 Job Object 并恢复。
    pub fn spawn(command: &mut Command) -> io::Result<(SharedChild, Self)> {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let job = Self::create()?;
        let child = SharedChild::spawn(command)?;
        if let Err(error) = job
            .assign(child.id())
            .and_then(|()| resume_process(child.id()))
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    /// 接管一个已经启动的进程。
    ///
    /// 该入口无法消除 spawn 与接管之间的竞态，仅供暂时不能挂起启动的既有调用方使用。
    pub fn create_for(pid: u32) -> io::Result<Self> {
        let job = Self::create()?;
        job.assign(pid)?;
        Ok(job)
    }

    fn assign(&self, pid: u32) -> io::Result<()> {
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assign = AssignProcessToJobObject(self.handle, process);
            CloseHandle(process);
            if assign == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

fn resume_process(pid: u32) -> io::Result<()> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = Thread32First(snapshot, &mut entry) != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, FALSE, entry.th32ThreadID);
                if thread.is_null() {
                    let error = io::Error::last_os_error();
                    CloseHandle(snapshot);
                    return Err(error);
                }
                let resumed = ResumeThread(thread);
                let error = (resumed == u32::MAX).then(io::Error::last_os_error);
                CloseHandle(thread);
                CloseHandle(snapshot);
                return error.map_or(Ok(()), Err);
            }
            found = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "suspended process thread not found",
        ))
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn create_for_invalid_pid_errors() {
        match ProcessJob::create_for(0xFFFFFFFE) {
            Err(_) => {}
            Ok(_) => panic!("invalid pid must error"),
        }
    }

    #[test]
    fn drop_kills_assigned_process_tree() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe");

        let job = ProcessJob::create_for(child.id()).expect("create job");
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => break,
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    panic!("child survived 3s after ProcessJob drop");
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    #[test]
    fn suspended_spawn_resumes_inside_job() {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/C", "exit 0"]);
        let (child, job) = ProcessJob::spawn(&mut command).expect("spawn inside job");

        let status = child.wait().expect("wait for resumed child");
        assert!(status.success());
        drop(job);
    }
}
