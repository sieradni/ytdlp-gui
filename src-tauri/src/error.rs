use serde::Serialize;

/// app-wide error type, serialized to the frontend as a readable string (§7:
/// every command returns `Result<T, AppError>`).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn other(msg: impl Into<String>) -> AppError {
    AppError::Other(msg.into())
}
