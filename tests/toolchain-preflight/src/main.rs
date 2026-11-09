fn main() {
    assert_eq!(std::env::consts::OS, "windows");
    assert_eq!(std::env::consts::ARCH, "x86_64");
    println!("Windows x64 native compilation, linking and execution OK");
}
