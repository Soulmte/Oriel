use std::fmt;

/// Error shape shared with the web client (`{ error: { code, message } }`).
#[derive(Debug, Clone)]
pub struct CoreError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl CoreError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(400, code, message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(403, code, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NOT_FOUND", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "INTERNAL", message)
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::bad_request("INVALID_PATH", message)
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let message = error.to_string();
        match error.kind() {
            ErrorKind::NotFound => Self::new(404, "NOT_FOUND", message),
            ErrorKind::PermissionDenied => Self::new(403, "PERMISSION_DENIED", message),
            ErrorKind::AlreadyExists => Self::new(409, "CONFLICT", message),
            _ => Self::new(500, "INTERNAL", message),
        }
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;
